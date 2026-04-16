# AI Monitor 功能说明

## 概述

AI Monitor 是一个用于监控和分析 AI 请求响应的功能模块，可以记录、查看和分析所有通过系统的 AI 请求。

## 功能特性

### 1. 数据持久化
- 使用 SQLite 数据库存储请求响应数据
- 数据库文件位置：`data/ai-monitor.db`
- 支持挂载到外部工具进行分析

### 2. 数据记录
- **请求元数据**：请求 ID、时间戳、协议类型、模型名称、状态等
- **请求内容**：原始请求体、处理后请求体
- **响应内容**：原始响应、转换后响应
- **流式数据**：完整的流式响应块记录
- **性能数据**：请求耗时、Token 使用量

### 3. Web 界面
- **列表视图**：展示所有请求的概览信息
- **详情视图**：全屏弹窗展示完整的请求响应详情
- **过滤功能**：按状态、Provider 过滤
- **分页浏览**：支持大量数据的分页查看

### 4. 详情展示优先级
1. **Messages**：清晰展示对话历史（role/content）
2. **流式 Delta**：逐块展示生成过程
3. **元数据**：模型、耗时、Token 使用量
4. **错误信息**：如果有错误，优先展示
5. **协议转换**：对比转换前后的差异

## 使用方法

### 启动服务
```bash
npm start
```

### 访问界面
1. 登录管理控制台
2. 点击侧边栏的 "AI 请求监控" 菜单项
3. 查看请求列表
4. 点击任意请求查看详情

### API 端点

#### 获取请求列表
```
GET /api/ai-monitor/requests?limit=50&offset=0&status=success&provider=openai
```

参数：
- `limit`: 每页数量（默认 100）
- `offset`: 偏移量（默认 0）
- `status`: 过滤状态（可选：success/error/processing）
- `provider`: 过滤 Provider（可选）

#### 获取请求详情
```
GET /api/ai-monitor/requests/{requestId}
```

#### 清理旧记录
```
POST /api/ai-monitor/cleanup
Content-Type: application/json

{
  "daysToKeep": 7
}
```

## 数据库结构

### ai_requests 表（主表）
- `id`: 主键
- `request_id`: 请求标识（唯一）
- `timestamp`: 请求时间
- `from_provider`: 原始协议
- `to_provider`: 目标协议
- `model`: 模型名称
- `is_stream`: 是否流式
- `status`: 状态（success/error/processing）
- `error_message`: 错误信息
- `duration_ms`: 请求耗时（毫秒）
- `prompt_tokens`: 提示词 Token 数
- `completion_tokens`: 完成 Token 数
- `total_tokens`: 总 Token 数

### ai_request_details 表（详情表）
- `id`: 主键
- `request_id`: 关联主表的请求 ID
- `original_request`: 原始请求 JSON
- `processed_request`: 处理后请求 JSON
- `native_response`: 原始响应 JSON
- `converted_response`: 转换后响应 JSON
- `stream_chunks`: 流式响应块 JSON

## 特性说明

### Messages 解析
- 支持 OpenAI 格式（role/content）
- 支持 Anthropic 格式（多模态 content）
- 自动识别和展示 Tool Calls
- 支持 Tool Results 展示

### 流式响应
- 记录所有流式响应块
- 按顺序展示 Delta 内容
- 支持查看完整的流式过程

### 协议转换对比
- 并排展示转换前后的请求/响应
- JSON 语法高亮
- 便于调试协议转换问题

## 配置

在 `config.json` 中可以配置数据库目录：

```json
{
  "aiMonitorDbDir": "data"
}
```

## 维护

### 清理旧数据
建议定期清理旧数据以节省磁盘空间：
- 通过 Web 界面：点击"清理旧记录"按钮
- 通过 API：调用 `/api/ai-monitor/cleanup` 端点

### 数据库备份
数据库文件位于 `data/ai-monitor.db`，可以直接复制备份：
```bash
cp data/ai-monitor.db data/ai-monitor.db.backup
```

### 外部分析
可以使用任何 SQLite 工具打开数据库进行分析：
```bash
sqlite3 data/ai-monitor.db
```

## 注意事项

1. **性能**：大量请求会增加数据库大小，建议定期清理
2. **隐私**：数据库包含完整的请求响应内容，注意保护隐私
3. **磁盘空间**：根据请求量，数据库可能会快速增长
4. **并发**：使用 WAL 模式提高并发性能

## 故障排查

### 数据库初始化失败
检查 `data` 目录是否有写入权限：
```bash
chmod 755 data
```

### 数据未记录
1. 检查 ai-monitor 插件是否启用
2. 查看日志中是否有错误信息
3. 验证数据库文件是否存在

### 界面无法加载
1. 检查浏览器控制台是否有 JavaScript 错误
2. 确认 API 端点是否正常响应
3. 检查认证 Token 是否有效
