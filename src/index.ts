import { Context, Schema, Session } from 'koishi'

export const name = 'chatluna-extractor'

export const inject = ['chatluna_character']

export const usage = `
提取 chatluna-character 的回复工具字段，并通过自定义指令输出。

新版 chatluna-character 默认提供 \`status\` 和 \`think\` 字段，本插件会直接通过
\`character_reply\` 工具接口读取它们。若仍在使用旧预设，可开启“使用旧版 XML
提取方式”兼容任意自定义 XML 标签。

使用 \`ex status\`、\`ex think\` 提取指定字段；添加 \`-s\` 可将结果发送到
指令发起者的私信。
`

export interface CommandConfig {
    name: string
    format: string
}

export interface Config {
    characterName: string
    tags: string[]
    commands: CommandConfig[]
    showLogs: boolean
    useLegacyXmlExtraction: boolean
    directMessageExtraction: boolean
}

export const Config: Schema<Config> = Schema.object({
    characterName: Schema.string()
        .default('AI')
        .description('角色名称，可在格式中使用 {name} 引用'),
    tags: Schema.array(Schema.string())
        .default(['status', 'think'])
        .description('要提取的回复工具字段；旧版兼容模式下表示 XML 标签（不含尖括号）'),
    commands: Schema.array(Schema.object({
        name: Schema.string().required().description('指令名称'),
        format: Schema.string()
            .role('textarea')
            .default('{name}在想：\n{think}')
            .description('输出格式。可用 {name} 和所有已配置的标签变量'),
    })).default([]).description('额外的自定义组合提取指令（默认请使用 ex <标签>）'),
    showLogs: Schema.boolean()
        .default(false)
        .description('是否在控制台显示提取日志'),
    useLegacyXmlExtraction: Schema.boolean()
        .default(false)
        .experimental()
        .description('除默认的 status、think 外，同时从模型回复中提取已配置的其他自定义 XML 标签'),
    directMessageExtraction: Schema.boolean()
        .default(false)
        .experimental()
        .description('自定义提取指令默认不在当前会话回复，改为私信指令发起者'),
})

interface ReplyToolField {
    name: string
    schema: Record<string, unknown>
    invoke: (ctx: Context, session: Session, value: unknown) => void | Promise<void>
    render: () => undefined
}

interface CharacterService {
    collect: (callback: (session: Session, messages: unknown[]) => Promise<void>) => void
    registerReplyToolField?: (field: ReplyToolField) => (() => void)
    logger?: {
        debug: (...args: unknown[]) => void
    }
}

declare module 'koishi' {
    interface Context {
        chatluna_character: CharacterService
    }
}

export function apply(ctx: Context, config: Config) {
    const logger = ctx.logger('chatluna-extractor')
    const extractedContents = new Map<string, Map<string, string>>()
    const characterService = ctx.chatluna_character

    const getSessionKey = (session: Session) => session.isDirect
        ? `private:${session.userId}`
        : `group:${session.guildId}`

    function storeContent(sessionKey: string, tag: string, value: unknown) {
        if (typeof value !== 'string' || !value.trim()) return

        let contents = extractedContents.get(sessionKey)
        if (!contents) {
            contents = new Map()
            extractedContents.set(sessionKey, contents)
        }
        contents.set(tag, value.trim())

        if (config.showLogs) {
            logger.info(`[${sessionKey}] 提取到 ${tag}: ${value.trim().substring(0, 100)}...`)
        }
    }

    if (characterService.registerReplyToolField) {
        const disposers = config.tags.map((tag) => characterService.registerReplyToolField!({
            name: tag,
            schema: {
                type: 'string',
                description: tag === 'status'
                    ? 'Continuously maintained status text. You MUST carry over and incrementally update the previous status; do not rewrite from scratch each time. Preserve recent history and memory entries until they are no longer relevant. Follow the exact format defined in the system prompt. Do not include XML tags in this field.'
                    : tag === 'think'
                        ? "The character's internal thoughts about the message."
                        : `Content for the <${tag}> block. Do not include XML tags.`,
            },
            invoke: (_ctx, session, value) => storeContent(getSessionKey(session), tag, value),
            render: () => undefined,
        }))

        ctx.on('dispose', () => disposers.forEach((dispose) => dispose()))
    }

    const defaultXmlTags = config.tags.filter((tag) => tag === 'status' || tag === 'think')
    const xmlTags = config.useLegacyXmlExtraction || !characterService.registerReplyToolField
        ? config.tags
        : defaultXmlTags
    if (xmlTags.length) enableXmlExtraction(xmlTags)

    function enableXmlExtraction(tags: string[]) {
        let currentSessionKey: string | null = null

        characterService.collect(async (session) => {
            currentSessionKey = getSessionKey(session)
            extractedContents.set(currentSessionKey, new Map())
        })

        const characterLogger = characterService.logger
        if (!characterLogger || typeof characterLogger.debug !== 'function') {
            return
        }

        const originalDebug = characterLogger.debug.bind(characterLogger)
        characterLogger.debug = (...args: unknown[]) => {
            originalDebug(...args)
            const message = args[0]
            if (typeof message !== 'string' || !/^model response:\s*/.test(message) || !currentSessionKey) return

            const response = message.replace(/^model response:\s*/, '')

            for (const tag of tags) {
                const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                const regex = new RegExp(`<${escapedTag}>([\\s\\S]*?)<\\/${escapedTag}>`, 'gi')
                const matches = Array.from(response.matchAll(regex), (match) => match[1].trim()).filter(Boolean)
                if (matches.length) storeContent(currentSessionKey, tag, matches.join('\n\n'))
            }
        }

        ctx.on('dispose', () => {
            characterLogger.debug = originalDebug
        })
    }

    function formatOutput(format: string, contents: Map<string, string>): string {
        let result = format.replace(/\{name\}/g, config.characterName)
        for (const tag of config.tags) {
            const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            result = result.replace(new RegExp(`\\{${escapedTag}\\}`, 'g'), contents.get(tag) || `（无${tag}内容）`)
        }
        return result
    }

    async function sendPrivately(session: Session, content: string) {
        if (!session.userId) throw new Error('无法获取指令发起者的用户 ID')
        await session.bot.sendPrivateMessage(session.userId, content)
    }

    async function deliver(session: Session, content: string, privately: boolean) {
        if (!privately) return content

        try {
            await sendPrivately(session, content)
            if (!session.isDirect) return '提取结果已发送到私信。'
        } catch (error) {
            logger.warn(error)
            return '私信发送失败，请确认机器人能够向你发送私信。'
        }
    }

    ctx.command('ex <tag:string>', '提取指定的角色回复字段')
        .option('private', '-s 发送到指令发起者的私信')
        .action(async ({ session, options }, tag) => {
            if (!session) return '无法获取会话信息'
            if (!tag) return `请指定要提取的标签，例如：ex ${config.tags[0] || 'think'}`
            if (!config.tags.includes(tag)) {
                return `未配置标签 ${tag}。可用标签：${config.tags.join('、') || '无'}`
            }

            const contents = extractedContents.get(getSessionKey(session))
            const content = contents?.get(tag)
            if (!content) return `当前没有可用的 ${tag} 内容`

            return await deliver(session, content, config.directMessageExtraction || !!options?.private)
        })

    for (const commandConfig of config.commands) {
        if (config.tags.includes(commandConfig.name)) {
            continue
        }

        ctx.command(commandConfig.name)
            .option('private', '-s 发送到指令发起者的私信')
            .action(async ({ session, options }) => {
                if (!session) return '无法获取会话信息'

                const contents = extractedContents.get(getSessionKey(session))
                if (!contents || contents.size === 0) return '当前没有可用的标签内容'

                const output = formatOutput(commandConfig.format, contents)
                if (config.directMessageExtraction || options?.private) {
                    return await deliver(session, output, true)
                }
                return output
            })
    }

    ctx.command('extractor.tags', '查看当前配置的所有标签')
        .action(() => config.tags.length
            ? `当前配置的标签变量：\n${config.tags.map((tag) => `- {${tag}}`).join('\n')}`
            : '当前没有配置任何标签。')

    ctx.command('extractor.commands', '查看当前配置的所有指令')
        .action(() => config.commands.length
            ? `当前配置的指令：\n${config.commands.map((command) => `- ${command.name}：${command.format}`).join('\n')}`
            : '当前没有配置任何指令。')

    logger.info('已启动')
}
