# koishi-plugin-chatluna-extractor

[![npm](https://img.shields.io/npm/v/koishi-plugin-chatluna-extractor?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-chatluna-extractor)

提取 `chatluna-character` 回复中的状态、思考等字段，并通过自定义指令查看。

## 新版适配

最新版 `chatluna-character` 使用 `character_reply` 工具生成回复。默认预设中的隐藏内容主要为：

- `<status>`：持续维护的角色状态和临时上下文
- `<think>`：角色对当前消息的内部想法
- `<action>`：工具调用和后续动作的渲染结果，由 `chatluna-character` 自身生成

本插件默认通过新版回复工具字段接口提取 `status` 和 `think`，不再依赖调试日志。

## 配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `characterName` | `AI` | `{name}` 变量显示的角色名 |
| `tags` | `['status', 'think']` | 要提取的回复工具字段 |
| `commands` | `[]` | 可选的额外自定义组合提取指令和输出格式 |
| `showLogs` | `false` | 显示提取日志 |
| `useLegacyXmlExtraction` | `false` | 实验性：除默认的 `status`、`think` 外，再提取其他自定义 XML 标签 |
| `directMessageExtraction` | `false` | 实验性：所有自定义提取指令默认将结果发到发起者私信 |

默认同时兼容 XML 回复与 `character_reply` 工具调用。使用 `CHARACTER` 或
`CHARACTER（工具调用）` 时无需切换 Extractor 配置。旧预设还会输出 `<memory>`、
`<relationship>` 等自定义 XML 时，请开启 `useLegacyXmlExtraction`，并在 `tags`
中填写对应标签名。

XML 提取通过 `chatluna_character/after-chat` 事件读取回复内容，不再依赖调试日志，
因此无需开启 `chatluna-character` 的调试日志级别，多个群同时回复时也不会串内容。

为避免与字段名称冲突，与标签同名的旧自定义指令会被自动跳过。例如旧配置中的
`think` 指令会改用 `ex think`。

## 指令

输出格式支持 `{name}` 以及与标签同名的变量，例如 `{status}`、`{think}`。

- `ex status`：提取角色状态
- `ex think`：提取角色内部想法
- `extractor.tags`：查看当前标签变量
- `extractor.commands`：查看所有自定义提取指令

`ex` 和每个自定义提取指令都支持 `-s`。例如 `ex status -s` 会把结果发送到指令发起者的私信；
这不要求开启 `directMessageExtraction`。

## 前置依赖

- [koishi-plugin-chatluna-character](https://www.npmjs.com/package/koishi-plugin-chatluna-character)

## 许可证

MIT
