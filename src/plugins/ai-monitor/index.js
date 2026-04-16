import logger from '../../utils/logger.js';
import aiMonitorDB from '../../utils/ai-monitor-db.js';

/**
 * AI 接口监控插件
 * 功能：
 * 1. 捕获 AI 接口的请求参数（转换前和转换后）
 * 2. 捕获 AI 接口的响应结果（转换前和转换后，流式响应聚合输出）
 * 3. 将数据持久化到 SQLite 数据库
 */
const aiMonitorPlugin = {
    name: 'ai-monitor',
    version: '1.0.0',
    description: 'AI 接口监控插件 - 捕获请求和响应参数（全链路协议转换监控，流式聚合输出，用于调试和分析）',
    type: 'middleware',
    _priority: 100,

    // 用于存储流式响应的中间状态
    streamCache: new Map(),

    async init(config) {
        // 初始化数据库
        aiMonitorDB.initialize(config.aiMonitorDbDir || 'data');
        logger.info('[AI Monitor Plugin] Initialized with database');
    },

    /**
     * 中间件：初始化请求上下文
     */
    async middleware(req, res, requestUrl, config) {
        const aiPaths = [
            '/v1/chat/completions', 
            '/v1/responses', 
            '/v1/messages', 
            '/v1beta/models',
            '/v1/images/generations',
            '/v1/images/edits'
        ];
        const isAiPath = aiPaths.some(path => requestUrl.pathname.includes(path));

        if (isAiPath && req.method === 'POST' && !config._monitorRequestId) {
            // 在监控插件中生成请求标识，并存入 config 以供全链路追踪
            const requestId = Date.now() + Math.random().toString(36).substring(2, 10);
            config._monitorRequestId = requestId;
        }
        
        return { handled: false };
    },

    hooks: {
        /**
         * 请求转换后的钩子
         */
        async onContentGenerated(config) {
            const { originalRequestBody, processedRequestBody, fromProvider, toProvider, model, _monitorRequestId, isStream } = config;
            if (!originalRequestBody) return;
            const traceRequestId = _monitorRequestId;

            setImmediate(() => {
                const hasConversion = JSON.stringify(originalRequestBody) !== JSON.stringify(processedRequestBody);
                logger.info(`[AI Monitor][${traceRequestId}] >>> Req Protocol: ${fromProvider}${hasConversion ? ' -> ' + toProvider : ''} | Model: ${model}`);

                if (hasConversion) {
                    logger.info(`[AI Monitor][${traceRequestId}] [Req Original]: ${JSON.stringify(originalRequestBody)}`);
                    logger.info(`[AI Monitor][${traceRequestId}] [Req Processed]: ${JSON.stringify(processedRequestBody)}`);
                } else {
                    logger.info(`[AI Monitor][${traceRequestId}] [Req]: ${JSON.stringify(originalRequestBody)}`);
                }

                // 写入数据库
                try {
                    // 提取用户 query 预览（取最后一条 user 消息的前 100 个字符）
                    let userQueryPreview = null;
                    const messages = processedRequestBody?.messages || originalRequestBody?.messages;
                    if (messages && Array.isArray(messages)) {
                        // 从后往前找第一条 user 消息
                        for (let i = messages.length - 1; i >= 0; i--) {
                            const msg = messages[i];
                            if (msg.role === 'user') {
                                let content = '';
                                if (typeof msg.content === 'string') {
                                    content = msg.content;
                                } else if (Array.isArray(msg.content)) {
                                    // 提取文本内容
                                    const textItems = msg.content.filter(item => item.type === 'text');
                                    content = textItems.map(item => item.text).join(' ');
                                }
                                userQueryPreview = content.substring(0, 150);
                                break;
                            }
                        }
                    }

                    aiMonitorDB.upsertRequest({
                        request_id: traceRequestId,
                        timestamp: Date.now(),
                        from_provider: fromProvider,
                        to_provider: toProvider,
                        model: model,
                        is_stream: isStream,
                        status: 'processing',
                        user_query_preview: userQueryPreview
                    });

                    aiMonitorDB.upsertRequestDetails(traceRequestId, {
                        original_request: originalRequestBody,
                        processed_request: processedRequestBody
                    });
                } catch (error) {
                    logger.error(`[AI Monitor][${traceRequestId}] Failed to write to database:`, error.message);
                }
            });

            // 初始化流式响应缓存
            if (isStream && traceRequestId) {
                if (!aiMonitorPlugin.streamCache.has(traceRequestId)) {
                    aiMonitorPlugin.streamCache.set(traceRequestId, {
                        nativeChunks: [],
                        convertedChunks: [],
                        fromProvider,
                        toProvider,
                        startTime: Date.now(),
                        timeoutId: null
                    });
                }
            }
        },

        /**
         * 非流式响应转换监控
         */
        async onUnaryResponse({ nativeResponse, clientResponse, fromProvider, toProvider, requestId, model }) {
            setImmediate(() => {
                const reqId = requestId || 'N/A';
                const hasConversion = JSON.stringify(nativeResponse) !== JSON.stringify(clientResponse);
                logger.info(`[AI Monitor][${reqId}] <<< Res Protocol: ${hasConversion ? toProvider + ' -> ' : ''}${fromProvider} (Unary)`);

                if (hasConversion) {
                    logger.info(`[AI Monitor][${reqId}] [Res Native]: ${JSON.stringify(nativeResponse)}`);
                    logger.info(`[AI Monitor][${reqId}] [Res Converted]: ${JSON.stringify(clientResponse)}`);
                } else {
                    logger.info(`[AI Monitor][${reqId}] [Res]: ${JSON.stringify(nativeResponse)}`);
                }

                // 写入数据库
                try {
                    // 检查主表记录是否存在，如果不存在则创建
                    const existingRequest = aiMonitorDB.db.prepare('SELECT request_id FROM ai_requests WHERE request_id = ?').get(reqId);
                    if (!existingRequest) {
                        logger.info(`[AI Monitor][${reqId}] Creating main table record for response`);
                        aiMonitorDB.upsertRequest({
                            request_id: reqId,
                            timestamp: Date.now(),
                            from_provider: fromProvider,
                            to_provider: toProvider,
                            model: model,
                            is_stream: false,
                            status: 'processing'
                        });
                    }

                    aiMonitorDB.upsertRequestDetails(reqId, {
                        native_response: nativeResponse,
                        converted_response: clientResponse
                    });

                    // 提取 token 使用量
                    const tokenUsage = clientResponse?.usage || nativeResponse?.usage;
                    aiMonitorDB.updateRequestStatus(reqId, 'success', null, null, tokenUsage);
                } catch (error) {
                    logger.error(`[AI Monitor][${reqId}] Failed to write unary response to database:`, error.message);
                }
            });
        },

        /**
         * 流式响应分块转换监控 - 聚合数据
         */
        async onStreamChunk({ nativeChunk, chunkToSend, fromProvider, toProvider, requestId }) {
            if (!requestId) return;

            if (!aiMonitorPlugin.streamCache.has(requestId)) {
                aiMonitorPlugin.streamCache.set(requestId, {
                    nativeChunks: [],
                    convertedChunks: [],
                    fromProvider,
                    toProvider,
                    startTime: Date.now(),
                    timeoutId: null
                });
            }

            const cache = aiMonitorPlugin.streamCache.get(requestId);

            // 过滤 null 值，并判断是否为数组类型
            if (nativeChunk != null) {
                if (Array.isArray(nativeChunk)) {
                    cache.nativeChunks.push(...nativeChunk.filter(item => item != null));
                } else {
                    cache.nativeChunks.push(nativeChunk);
                }
            }

            if (chunkToSend != null) {
                if (Array.isArray(chunkToSend)) {
                    cache.convertedChunks.push(...chunkToSend.filter(item => item != null));
                } else {
                    cache.convertedChunks.push(chunkToSend);
                }
            }

            // 记录结束时间
            cache.duration = Date.now() - cache.startTime;

            // 清除之前的定时器
            if (cache.timeoutId) {
                clearTimeout(cache.timeoutId);
            }

            // 设置新的定时器，在最后一个 chunk 后 500ms 写入数据库
            cache.timeoutId = setTimeout(() => {
                const hasConversion = JSON.stringify(cache.nativeChunks) !== JSON.stringify(cache.convertedChunks);
                logger.info(`[AI Monitor][${requestId}] <<< Stream Response Aggregated: ${hasConversion ? cache.toProvider + ' -> ' : ''}${cache.fromProvider}`);

                if (hasConversion) {
                    logger.info(`[AI Monitor][${requestId}] [Res Native Full]: ${JSON.stringify(cache.nativeChunks)}`);
                    logger.info(`[AI Monitor][${requestId}] [Res Converted Full]: ${JSON.stringify(cache.convertedChunks)}`);
                } else {
                    logger.info(`[AI Monitor][${requestId}] [Res Full]: ${JSON.stringify(cache.nativeChunks)}`);
                }

                // 写入数据库
                try {
                    // 检查主表记录是否存在，如果不存在则创建
                    const existingRequest = aiMonitorDB.db.prepare('SELECT request_id FROM ai_requests WHERE request_id = ?').get(requestId);
                    if (!existingRequest) {
                        logger.info(`[AI Monitor][${requestId}] Creating main table record for stream response`);
                        aiMonitorDB.upsertRequest({
                            request_id: requestId,
                            timestamp: Date.now(),
                            from_provider: cache.fromProvider,
                            to_provider: cache.toProvider,
                            model: null,
                            is_stream: true,
                            status: 'processing'
                        });
                    }

                    // 提取 token usage（从最后一个 chunk 中）
                    let tokenUsage = null;
                    const lastChunk = cache.convertedChunks[cache.convertedChunks.length - 1] || cache.nativeChunks[cache.nativeChunks.length - 1];
                    if (lastChunk?.usage) {
                        tokenUsage = lastChunk.usage;
                    }

                    aiMonitorDB.upsertRequestDetails(requestId, {
                        stream_chunks: {
                            native: cache.nativeChunks,
                            converted: cache.convertedChunks
                        }
                    });
                    aiMonitorDB.updateRequestStatus(requestId, 'success', null, cache.duration, tokenUsage);
                } catch (error) {
                    logger.error(`[AI Monitor][${requestId}] Failed to write stream data to database:`, error.message);
                }

                aiMonitorPlugin.streamCache.delete(requestId);
            }, 500);
        },

        /**
         * 内部请求转换监控
         */
        async onInternalRequestConverted({ requestId, internalRequest, converterName }) {
            setImmediate(() => {
                const reqId = requestId || 'N/A';
                logger.info(`[AI Monitor][${reqId}] >>> Internal Req Converted [${converterName}]: ${JSON.stringify(internalRequest)}`);
            });
        }
    }
};

export default aiMonitorPlugin;
