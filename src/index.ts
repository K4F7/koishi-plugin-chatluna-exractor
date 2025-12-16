import { Context, Schema, Session } from 'koishi'

export const name = 'chatluna-exractor'

export const inject = ['chatluna_character']

export const usage = `
## 使用说明

此插件用于提取 chatluna-character 输出中特定 XML 标签的内容。

- 默认提取 \`<think>\` 标签内容
- 可在配置中添加或删除要提取的标签
- 每个标签会自动注册对应的指令，例如配置了 \`think\` 标签，就会注册 \`think\` 指令
- 只保留最新一条回复的提取内容
`

export interface Config {
    tags: string[]
}

export const Config: Schema<Config> = Schema.object({
    tags: Schema.array(String)
        .default(['think'])
        .description('要提取的 XML 标签列表（不包含尖括号）'),
})

// 扩展 Context 类型
declare module 'koishi' {
    interface Context {
        chatluna_character: {
            collect: (callback: (session: Session, messages: any[]) => Promise<void>) => void
            logger: {
                debug: (...args: any[]) => void
                info: (...args: any[]) => void
                warn: (...args: any[]) => void
                error: (...args: any[]) => void
            }
        }
    }
}

export function apply(ctx: Context, config: Config) {
    const logger = ctx.logger('chatluna-exractor')

    // 存储最新提取的内容，按群组 ID 分组，每个标签只保留最新值
    const extractedContents = new Map<string, Map<string, string | null>>()

    // 解析 XML 标签内容
    function extractTagContent(text: string, tag: string): string | null {
        const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'gi')
        const matches: string[] = []
        let match: RegExpExecArray | null

        while ((match = regex.exec(text)) !== null) {
            matches.push(match[1].trim())
        }

        return matches.length > 0 ? matches.join('\n\n') : null
    }

    // 处理模型响应，提取标签内容
    function processModelResponse(guildId: string, response: string): void {
        // 重置该群组的提取内容
        const guildContents = new Map<string, string | null>()
        extractedContents.set(guildId, guildContents)

        for (const tag of config.tags) {
            const tagContent = extractTagContent(response, tag)

            if (tagContent) {
                logger.info(`[${guildId}] 提取到 <${tag}> 标签内容: ${tagContent.substring(0, 100)}...`)
                guildContents.set(tag, tagContent)
            }
        }
    }

    // 当前正在处理的群组 ID
    let currentGuildId: string | null = null

    // 使用 chatluna_character.collect 来追踪当前处理的群组
    ctx.chatluna_character.collect(async (session) => {
        currentGuildId = session.guildId
        logger.info(`[collect] 开始处理群组: ${currentGuildId}`)
    })

    // 拦截 chatluna_character.logger 的 debug 输出
    const characterService = ctx.chatluna_character as any
    const characterLogger = characterService.logger

    if (characterLogger && typeof characterLogger.debug === 'function') {
        const originalDebug = characterLogger.debug.bind(characterLogger)

        characterLogger.debug = (...args: any[]) => {
            // 调用原始的 debug 方法
            originalDebug(...args)

            // 检查是否是模型响应日志
            const message = args[0]
            if (typeof message === 'string' && message.startsWith('model response: ')) {
                const response = message.substring('model response: '.length)

                if (currentGuildId) {
                    logger.info(`[拦截] 捕获到模型响应，群组: ${currentGuildId}`)
                    processModelResponse(currentGuildId, response)
                }
            }
        }

        // 清理函数
        ctx.on('dispose', () => {
            characterLogger.debug = originalDebug
        })

        logger.info('成功拦截 chatluna_character.logger.debug')
    } else {
        logger.warn('无法拦截 chatluna_character.logger，logger 不存在或 debug 方法不可用')
    }

    // 为每个标签注册指令
    for (const tag of config.tags) {
        ctx.command(tag, `查看最新回复中 <${tag}> 标签的内容`)
            .action(({ session }) => {
                if (!session) return '无法获取会话信息'

                const guildId = session.guildId
                const guildContents = extractedContents.get(guildId)

                if (!guildContents) {
                    return `没有 <${tag}> 标签包裹的信息`
                }

                const content = guildContents.get(tag)

                if (!content) {
                    return `没有 <${tag}> 标签包裹的信息`
                }

                return content
            })
    }

    // 注册查看所有标签的指令
    ctx.command('extractor.list', '查看当前配置的所有标签')
        .action(() => {
            if (config.tags.length === 0) {
                return '当前没有配置任何标签。'
            }

            return `当前配置的标签:\n${config.tags.map((t) => `- <${t}>`).join('\n')}`
        })
}
