# koishi-plugin-chatluna-exractor

[![npm](https://img.shields.io/npm/v/koishi-plugin-chatluna-exractor?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-chatluna-exractor)

提取 chatluna-character 输出中特定 XML 标签的内容。

## 功能介绍

当使用 [koishi-plugin-chatluna-character](https://www.npmjs.com/package/koishi-plugin-chatluna-character) 时，AI 模型的回复通常包含多种 XML 标签，例如 `<think>`（思考过程）、`<memory>`（记忆）等。这些标签内容在最终发送给用户时会被过滤掉。

本插件可以拦截并提取这些标签内容，让用户可以通过指令查看 AI 的"内心想法"。

## 安装

```bash
npm install koishi-plugin-chatluna-exractor
# 或
yarn add koishi-plugin-chatluna-exractor
```

## 前置依赖

- [koishi-plugin-chatluna-character](https://www.npmjs.com/package/koishi-plugin-chatluna-character)

## 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| tags | string[] | `['think']` | 要提取的 XML 标签列表（不包含尖括号） |

## 使用方法

### 指令

插件会根据配置的标签自动注册对应的指令：

- **`<tag>`** - 查看最新回复中对应标签的内容（例如配置了 `think`，就会注册 `think` 指令）
- **`extractor.list`** - 查看当前配置的所有标签

### 示例

假设 AI 模型返回了如下内容：

```xml
<think>
用户在问我天气，我应该友好地回复。
</think>

<output>
<message>今天天气不错呢！</message>
</output>
```

用户只会看到"今天天气不错呢！"，但可以通过发送 `think` 指令查看 AI 的思考过程。

## 注意事项

- 每个群组只保留最新一条回复的提取内容
- 插件通过拦截 chatluna-character 的日志输出来获取原始模型响应，因此需要确保 chatluna-character 的日志级别包含 debug

## 许可证

MIT