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
}

interface CharacterAfterChatPayload {
    session: Session
    status?: string | null
    lastResponseMessage?: Record<string, unknown>
}

declare module 'koishi' {
    interface Context {
        chatluna_character: CharacterService
    }
}

/**
 * chatluna-character 通过 JSON 快照传递回复消息，正文位于 LangChain 序列化后的
 * `kwargs.content`；同时兼容普通对象与分段内容数组。
 */
function readMessageContent(message: unknown): string {
    if (!message || typeof message !== 'object') return ''

    const record = message as Record<string, unknown>
    const kwargs = record.kwargs as Record<string, unknown> | undefined
    const content = record.content ?? kwargs?.content

    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''

    return content
        .map((part) => typeof part === 'string'
            ? part
            : typeof (part as Record<string, unknown>)?.text === 'string'
                ? (part as Record<string, unknown>).text as string
                : '')
        .filter(Boolean)
        .join('\n')
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

    function extractXmlTags(sessionKey: string, response: string, tags: string[]) {
        for (const tag of tags) {
            const escapedTag = escapeRegExp(tag)
            const regex = new RegExp(`<${escapedTag}>([\\s\\S]*?)<\\/${escapedTag}>`, 'gi')
            const matches = Array.from(response.matchAll(regex), (match) => match[1].trim()).filter(Boolean)
            if (matches.length) storeContent(sessionKey, tag, matches.join('\n\n'))
        }
    }

    /**
     * 使用 `after-chat` 事件而非拦截调试日志：该事件直接携带对应的 session，
     * 因此多个会话并发回复时不会互相串内容。
     */
    function enableXmlExtraction(tags: string[]) {
        characterService.collect(async (session) => {
            extractedContents.set(getSessionKey(session), new Map())
        })

        // 事件名不在 koishi 的 Events 类型中声明，避免与 chatluna-character
        // 自身的声明冲突导致使用者项目类型检查报错。
        const onAfterChat = (payload: CharacterAfterChatPayload) => {
            const session = payload?.session
            if (!session) return

            const sessionKey = getSessionKey(session)
            const response = readMessageContent(payload.lastResponseMessage)
            if (response) extractXmlTags(sessionKey, response, tags)

            // status 由 chatluna-character 单独持久化，回复正文中不一定包含 <status>。
            if (tags.includes('status') && typeof payload.status === 'string') {
                storeContent(sessionKey, 'status', payload.status)
            }
        }

        ;(ctx as Context & {
            on(name: string, listener: (payload: CharacterAfterChatPayload) => void): () => boolean
        }).on('chatluna_character/after-chat', onAfterChat)
    }

    function formatOutput(format: string, contents: Map<string, string>): string {
        let result = format.replace(/\{name\}/g, config.characterName)
        for (const tag of config.tags) {
            const escapedTag = escapeRegExp(tag)
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

    // 无效或重复的指令名会让 ctx.command 抛错并导致整个插件启动失败，这里提前跳过。
    const reservedNames = new Set(['ex', 'extractor', 'extractor.tags', 'extractor.commands'])
    const registeredNames = new Set<string>()

    for (const commandConfig of config.commands) {
        const commandName = commandConfig.name?.trim()

        if (!commandName) {
            logger.warn('跳过一个名称为空的自定义指令。')
            continue
        }
        if (config.tags.includes(commandName)) {
            continue
        }
        if (reservedNames.has(commandName)) {
            logger.warn(`跳过自定义指令 ${commandName}：该名称已被插件占用。`)
            continue
        }
        if (registeredNames.has(commandName)) {
            logger.warn(`跳过重复的自定义指令 ${commandName}。`)
            continue
        }
        registeredNames.add(commandName)

        ctx.command(commandName)
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
