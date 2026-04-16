/**
 * AI Monitor 管理模块 - LangSmith 风格
 */

import { renderJsonTree, initJsonViewers } from './json-viewer.js';

let currentPage = 0;
const pageSize = 50;
let currentFilters = {
    status: '',
    provider: ''
};
let currentSection = 'metadata';

/**
 * 初始化 AI Monitor
 */
export function initAIMonitor() {
    console.log('Initializing AI Monitor...');

    // 绑定事件
    document.getElementById('refreshRequestsBtn')?.addEventListener('click', () => {
        currentPage = 0; // 重置到第一页
        loadRequests();
    });
    document.getElementById('cleanupOldBtn')?.addEventListener('click', handleCleanup);
    document.getElementById('statusFilter')?.addEventListener('change', handleFilterChange);
    document.getElementById('providerFilter')?.addEventListener('input', debounce(handleFilterChange, 500));
    document.getElementById('prevPageBtn')?.addEventListener('click', () => changePage(-1));
    document.getElementById('nextPageBtn')?.addEventListener('click', () => changePage(1));
    document.getElementById('closeModalBtn')?.addEventListener('click', closeDetailModal);

    // 点击遮罩关闭
    document.querySelector('.trace-modal-overlay')?.addEventListener('click', closeDetailModal);

    // 加载初始数据（从第一页开始）
    currentPage = 0;
    loadRequests();
}

/**
 * 加载请求列表
 */
async function loadRequests() {
    const container = document.getElementById('requestsListContainer');
    if (!container) return;

    container.innerHTML = `
        <div class="loading-state">
            <div class="loading-spinner"></div>
            <span>Loading traces...</span>
        </div>
    `;

    try {
        const params = new URLSearchParams({
            limit: pageSize,
            offset: currentPage * pageSize,
            ...(currentFilters.status && { status: currentFilters.status }),
            ...(currentFilters.provider && { provider: currentFilters.provider })
        });

        const response = await fetch(`/api/ai-monitor/requests?${params}`, {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`
            }
        });

        if (!response.ok) throw new Error('Failed to load requests');

        const result = await response.json();
        renderRequestsList(result.data);
        updatePagination(result.pagination);
        updateStats(result.data.length);
    } catch (error) {
        console.error('Failed to load requests:', error);
        container.innerHTML = `
            <div class="loading-state">
                <span style="color: var(--monitor-error);">❌ Failed to load: ${error.message}</span>
            </div>
        `;
    }
}

/**
 * 渲染请求列表
 */
function renderRequestsList(requests) {
    const container = document.getElementById('requestsListContainer');
    if (!container) return;

    if (requests.length === 0) {
        container.innerHTML = `
            <div class="loading-state">
                <span>📭 No traces found</span>
            </div>
        `;
        return;
    }

    container.innerHTML = requests.map(req => `
        <div class="request-card" data-request-id="${req.request_id}">
            <div class="request-card-header">
                <div class="request-id-group">
                    <div class="request-id">${req.request_id}</div>
                    <div class="request-timestamp">${formatTimestamp(req.timestamp)}</div>
                </div>
                <span class="request-status-badge status-${req.status}">${req.status}</span>
            </div>
            ${req.user_query_preview ? `
                <div class="request-query-preview">
                    <span class="query-icon">💬</span>
                    <span class="query-text">${escapeHtml(req.user_query_preview)}</span>
                </div>
            ` : ''}
            <div class="request-card-body">
                <div class="request-meta-item">
                    <span class="meta-label">Provider</span>
                    <span class="meta-value">${req.from_provider}${req.to_provider && req.from_provider !== req.to_provider ? ' → ' + req.to_provider : ''}</span>
                </div>
                <div class="request-meta-item">
                    <span class="meta-label">Model</span>
                    <span class="meta-value highlight">${req.model || 'N/A'}</span>
                </div>
                ${req.duration_ms ? `
                <div class="request-meta-item">
                    <span class="meta-label">Duration</span>
                    <span class="meta-value">${req.duration_ms}ms</span>
                </div>
                ` : ''}
                ${req.total_tokens ? `
                <div class="request-meta-item">
                    <span class="meta-label">Tokens</span>
                    <span class="meta-value">${req.total_tokens}</span>
                </div>
                ` : ''}
                ${req.is_stream ? '<span class="stream-badge">⚡ Stream</span>' : ''}
            </div>
        </div>
    `).join('');

    // 绑定点击事件
    container.querySelectorAll('.request-card').forEach(card => {
        card.addEventListener('click', () => {
            const requestId = card.dataset.requestId;
            loadRequestDetail(requestId);
        });
    });
}

/**
 * 加载请求详情
 */
async function loadRequestDetail(requestId) {
    const modal = document.getElementById('aiMonitorDetailModal');
    const sidebar = document.getElementById('traceSidebar');
    const content = document.getElementById('requestDetailContent');
    const title = document.getElementById('modalRequestId');

    if (!modal || !sidebar || !content || !title) return;

    // 显示模态框
    modal.style.display = 'flex';
    title.textContent = requestId;
    content.innerHTML = `
        <div class="loading-state">
            <div class="loading-spinner"></div>
            <span>Loading trace details...</span>
        </div>
    `;

    try {
        const response = await fetch(`/api/ai-monitor/requests/${encodeURIComponent(requestId)}`, {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`
            }
        });

        if (!response.ok) throw new Error('Failed to load request detail');

        const result = await response.json();
        renderTraceSidebar(result.data);
        renderRequestDetail(result.data);
    } catch (error) {
        console.error('Failed to load request detail:', error);
        content.innerHTML = `
            <div class="loading-state">
                <span style="color: var(--monitor-error);">❌ Failed to load: ${error.message}</span>
            </div>
        `;
    }
}

/**
 * 渲染侧边栏导航
 */
function renderTraceSidebar(detail) {
    const sidebar = document.getElementById('traceSidebar');
    if (!sidebar) return;

    const sections = [
        { id: 'metadata', icon: '📋', label: '元数据' },
        { id: 'messages', icon: '💬', label: '对话消息', show: detail.original_request?.messages || detail.processed_request?.messages },
        { id: 'input', icon: '📥', label: '请求详情' },
        { id: 'output', icon: '📤', label: '响应详情', show: detail.native_response || detail.converted_response },
        { id: 'stream', icon: '⚡', label: '流式输出', show: detail.is_stream && detail.stream_chunks },
        { id: 'conversion', icon: '🔄', label: '协议转换', show: detail.from_provider !== detail.to_provider }
    ].filter(s => s.show !== false);

    sidebar.innerHTML = sections.map(section => `
        <div class="trace-nav-item ${section.id === currentSection ? 'active' : ''}" data-section="${section.id}">
            <span class="trace-nav-icon">${section.icon}</span>
            <span>${section.label}</span>
        </div>
    `).join('');

    // 绑定导航点击
    sidebar.querySelectorAll('.trace-nav-item').forEach(item => {
        item.addEventListener('click', () => {
            currentSection = item.dataset.section;
            sidebar.querySelectorAll('.trace-nav-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            renderRequestDetail(detail);
        });
    });
}

/**
 * 渲染请求详情
 */
function renderRequestDetail(detail) {
    const content = document.getElementById('requestDetailContent');
    if (!content) return;

    let html = '';

    switch (currentSection) {
        case 'metadata':
            html = renderMetadataSection(detail);
            break;
        case 'messages':
            html = renderMessagesSection(detail);
            break;
        case 'input':
            html = renderInputSection(detail);
            break;
        case 'output':
            html = renderOutputSection(detail);
            break;
        case 'stream':
            html = renderStreamSection(detail);
            break;
        case 'conversion':
            html = renderConversionSection(detail);
            break;
    }

    content.innerHTML = html;

    // 初始化 JSON 查看器
    initJsonViewers(content);

    // 绑定工具调用展开事件
    content.querySelectorAll('.tool-call-header').forEach(header => {
        header.addEventListener('click', () => {
            header.parentElement.classList.toggle('expanded');
        });
    });
}

/**
 * 渲染元数据部分
 */
function renderMetadataSection(detail) {
    return `
        <div class="trace-section">
            <h3 class="trace-section-title">
                <span class="section-icon">📋</span>
                Request Metadata
            </h3>
            <div class="metadata-grid">
                <div class="metadata-item">
                    <div class="metadata-label">Request ID</div>
                    <div class="metadata-value">${detail.request_id}</div>
                </div>
                <div class="metadata-item">
                    <div class="metadata-label">Timestamp</div>
                    <div class="metadata-value">${formatTimestamp(detail.timestamp)}</div>
                </div>
                <div class="metadata-item">
                    <div class="metadata-label">Protocol</div>
                    <div class="metadata-value">${detail.from_provider}${detail.to_provider && detail.from_provider !== detail.to_provider ? ' → ' + detail.to_provider : ''}</div>
                </div>
                <div class="metadata-item">
                    <div class="metadata-label">Model</div>
                    <div class="metadata-value">${detail.model || 'N/A'}</div>
                </div>
                <div class="metadata-item">
                    <div class="metadata-label">Status</div>
                    <div class="metadata-value">
                        <span class="request-status-badge status-${detail.status}">${detail.status}</span>
                    </div>
                </div>
                <div class="metadata-item">
                    <div class="metadata-label">Type</div>
                    <div class="metadata-value">${detail.is_stream ? '⚡ Stream' : '📦 Unary'}</div>
                </div>
                ${detail.duration_ms ? `
                <div class="metadata-item">
                    <div class="metadata-label">Duration</div>
                    <div class="metadata-value">${detail.duration_ms}ms</div>
                </div>
                ` : ''}
                ${detail.total_tokens ? `
                <div class="metadata-item">
                    <div class="metadata-label">Tokens</div>
                    <div class="metadata-value">${detail.prompt_tokens || 0} + ${detail.completion_tokens || 0} = ${detail.total_tokens}</div>
                </div>
                ` : ''}
            </div>
            ${detail.error_message ? `
                <div class="metadata-item" style="margin-top: 1rem;">
                    <div class="metadata-label">Error Message</div>
                    <div class="code-block">
                        <div class="code-content" style="color: var(--monitor-error);">${escapeHtml(detail.error_message)}</div>
                    </div>
                </div>
            ` : ''}
        </div>
    `;
}

/**
 * 渲染消息部分
 */
function renderMessagesSection(detail) {
    let messages = detail.processed_request?.messages || detail.original_request?.messages || [];

    // 如果是流式响应，需要从 stream_chunks 中重建 assistant 的回复
    if (detail.is_stream && detail.stream_chunks) {
        const chunks = detail.stream_chunks.converted || detail.stream_chunks.native || [];
        const assistantMessage = reconstructAssistantMessage(chunks);

        if (assistantMessage) {
            // 将重建的 assistant 消息添加到消息列表
            messages = [...messages, assistantMessage];
        }
    }

    return `
        <div class="trace-section">
            <h3 class="trace-section-title">
                <span class="section-icon">💬</span>
                对话消息 (${messages.length})
            </h3>
            <div class="messages-container">
                ${messages.map((msg, idx) => renderMessage(msg, idx)).join('')}
            </div>
        </div>
    `;
}

/**
 * 从流式 chunks 中重建 assistant 消息
 */
function reconstructAssistantMessage(chunks) {
    let textContent = '';
    const toolCalls = [];
    let stopReason = null;

    for (const chunk of chunks) {
        // OpenAI 格式
        if (chunk.choices && chunk.choices[0]) {
            const delta = chunk.choices[0].delta;

            // 累积文本内容
            if (delta?.content) {
                textContent += delta.content;
            }

            // 累积 tool calls
            if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                    const index = tc.index || 0;
                    if (!toolCalls[index]) {
                        toolCalls[index] = {
                            id: tc.id || '',
                            type: 'function',
                            function: {
                                name: tc.function?.name || '',
                                arguments: ''
                            }
                        };
                    }
                    if (tc.function?.name) {
                        toolCalls[index].function.name = tc.function.name;
                    }
                    if (tc.function?.arguments) {
                        toolCalls[index].function.arguments += tc.function.arguments;
                    }
                }
            }

            // 获取 stop reason
            if (chunk.choices[0].finish_reason) {
                stopReason = chunk.choices[0].finish_reason;
            }
        }

        // Anthropic 格式
        if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
            textContent += chunk.delta.text;
        }

        if (chunk.type === 'content_block_start' && chunk.content_block?.type === 'tool_use') {
            toolCalls.push({
                id: chunk.content_block.id,
                type: 'tool_use',
                name: chunk.content_block.name,
                input: {}
            });
        }

        if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'input_json_delta') {
            // Anthropic 的 tool input 是增量 JSON
            const lastTool = toolCalls[toolCalls.length - 1];
            if (lastTool) {
                if (!lastTool.inputJson) {
                    lastTool.inputJson = '';
                }
                lastTool.inputJson += chunk.delta.partial_json;
            }
        }

        if (chunk.delta?.stop_reason) {
            stopReason = chunk.delta.stop_reason;
        }
    }

    // 如果没有任何内容，返回 null
    if (!textContent && toolCalls.length === 0) {
        return null;
    }

    // 构建 assistant 消息
    const message = {
        role: 'assistant',
        content: []
    };

    // 添加文本内容
    if (textContent) {
        message.content.push({
            type: 'text',
            text: textContent
        });
    }

    // 添加 tool calls
    if (toolCalls.length > 0) {
        // 处理 Anthropic 格式的 tool calls
        for (const tc of toolCalls) {
            if (tc.type === 'tool_use') {
                try {
                    tc.input = tc.inputJson ? JSON.parse(tc.inputJson) : {};
                    delete tc.inputJson;
                } catch (e) {
                    tc.input = {};
                }
                message.content.push(tc);
            }
        }

        // 处理 OpenAI 格式的 tool calls
        const openaiToolCalls = toolCalls.filter(tc => tc.type === 'function');
        if (openaiToolCalls.length > 0) {
            message.tool_calls = openaiToolCalls;
        }
    }

    // 如果 content 是空数组，转为字符串
    if (message.content.length === 0) {
        message.content = '';
    } else if (message.content.length === 1 && message.content[0].type === 'text') {
        // 如果只有一个文本块，简化为字符串
        message.content = message.content[0].text;
    }

    return message;
}

/**
 * 渲染单条消息
 */
function renderMessage(msg, index) {
    const role = msg.role || 'unknown';
    const avatarEmoji = role === 'user' ? '👤' : role === 'assistant' ? '🤖' : '⚙️';
    const messageId = `msg-${index}`;

    // 提取文本内容
    let textContent = '';
    if (typeof msg.content === 'string') {
        textContent = msg.content;
    } else if (Array.isArray(msg.content)) {
        const textItems = msg.content.filter(item => item.type === 'text');
        textContent = textItems.map(item => item.text).join('\n\n');
    }

    // 渲染其他内容（图片、工具调用等）
    let otherContentHtml = '';
    if (Array.isArray(msg.content)) {
        otherContentHtml = msg.content.map(item => {
            if (item.type === 'image_url') {
                return `<div class="message-content-box">🖼️ [Image]</div>`;
            } else if (item.type === 'tool_use') {
                return renderToolCall(item.name, item.input, item.id);
            } else if (item.type === 'tool_result') {
                // 尝试解析 tool_result 的内容
                let resultData = item.content;
                try {
                    // 如果是 JSON 字符串，解析它
                    if (typeof item.content === 'string') {
                        resultData = JSON.parse(item.content);
                    }
                } catch (e) {
                    // 如果解析失败，保持原样
                    resultData = item.content;
                }

                return `
                    <div class="tool-call-card tool-result-card">
                        <div class="tool-call-header">
                            <div class="tool-call-title">
                                <span class="tool-call-icon">✅</span>
                                Tool Result: ${item.tool_use_id}
                            </div>
                            <span class="tool-call-expand">▼</span>
                        </div>
                        <div class="tool-call-body">
                            <div class="tool-call-content">
                                ${typeof resultData === 'string' ? `<div class="message-content-box">${escapeHtml(resultData)}</div>` : renderJsonTree(resultData)}
                            </div>
                        </div>
                    </div>
                `;
            }
            return '';
        }).join('');
    }

    // OpenAI tool calls
    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        otherContentHtml += msg.tool_calls.map(tc => {
            const name = tc.function?.name || tc.name;
            const args = tc.function?.arguments || tc.arguments || '{}';
            return renderToolCall(name, JSON.parse(args), tc.id);
        }).join('');
    }

    return `
        <div class="message-bubble ${role}">
            <div class="message-avatar">${avatarEmoji}</div>
            <div class="message-content-wrapper">
                <div class="message-header">
                    <div class="message-role-label">${role}</div>
                    ${textContent ? `
                        <div class="message-view-toggle">
                            <button class="view-toggle-btn active" data-view="markdown" data-message-id="${messageId}" onclick="window.toggleMessageView('${messageId}', 'markdown')">
                                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                                    <path d="M2 3h12v10H2V3zm1 1v8h10V4H3zm2 6V6l2 2 2-2v4H7V8L5 10z" fill="currentColor"/>
                                </svg>
                                Markdown
                            </button>
                            <button class="view-toggle-btn" data-view="json" data-message-id="${messageId}" onclick="window.toggleMessageView('${messageId}', 'json')">
                                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                                    <path d="M4 2H2v2h2V2zm0 4H2v2h2V6zm0 4H2v2h2v-2zm12-8h-2v2h2V2zm0 4h-2v2h2V6zm0 4h-2v2h2v-2zM8 2H6v2h2V2zm0 4H6v2h2V6zm0 4H6v2h2v-2z" fill="currentColor"/>
                                </svg>
                                JSON
                            </button>
                        </div>
                    ` : ''}
                </div>
                ${textContent ? `
                    <!-- Markdown 视图 -->
                    <div class="message-view" data-view="markdown" data-message-id="${messageId}">
                        <div class="message-content-markdown">${renderMarkdown(textContent)}</div>
                    </div>
                    <!-- JSON 视图 -->
                    <div class="message-view hidden" data-view="json" data-message-id="${messageId}">
                        ${renderJsonTree(msg)}
                    </div>
                ` : renderJsonTree(msg)}
                ${otherContentHtml}
            </div>
        </div>
    `;
}

/**
 * 渲染工具调用
 */
function renderToolCall(name, input, id) {
    return `
        <div class="tool-call-card">
            <div class="tool-call-header">
                <div class="tool-call-title">
                    <span class="tool-call-icon">🔧</span>
                    ${name}
                    ${id ? `<span style="color: var(--monitor-text-secondary); font-size: 0.75rem;">(${id})</span>` : ''}
                </div>
                <span class="tool-call-expand">▼</span>
            </div>
            <div class="tool-call-body">
                <div class="tool-call-content">
                    ${renderJsonTree(input)}
                </div>
            </div>
        </div>
    `;
}

/**
 * 渲染输入部分
 */
function renderInputSection(detail) {
    const request = detail.processed_request || detail.original_request;
    if (!request) return '<div class="loading-state"><span>No input data</span></div>';

    return `
        <div class="trace-section">
            <h3 class="trace-section-title">
                <span class="section-icon">📥</span>
                Request Input
            </h3>
            ${renderJsonTree(request)}
        </div>
    `;
}

/**
 * 渲染输出部分
 */
function renderOutputSection(detail) {
    const response = detail.converted_response || detail.native_response;
    if (!response) return '<div class="loading-state"><span>No output data</span></div>';

    return `
        <div class="trace-section">
            <h3 class="trace-section-title">
                <span class="section-icon">📤</span>
                Response Output
            </h3>
            ${renderJsonTree(response)}
        </div>
    `;
}

/**
 * 渲染流式部分
 */
function renderStreamSection(detail) {
    if (!detail.stream_chunks) return '<div class="loading-state"><span>No stream data</span></div>';

    const chunks = detail.stream_chunks.converted || detail.stream_chunks.native || [];

    return `
        <div class="trace-section">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
                <h3 class="trace-section-title" style="margin: 0;">
                    <span class="section-icon">⚡</span>
                    Stream Chunks (${chunks.length})
                </h3>
                <div class="stream-view-toggle">
                    <button class="toggle-btn" data-view="json" onclick="window.toggleStreamView('json')">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                            <path d="M4 2H2v2h2V2zm0 4H2v2h2V6zm0 4H2v2h2v-2zm12-8h-2v2h2V2zm0 4h-2v2h2V6zm0 4h-2v2h2v-2zM8 2H6v2h2V2zm0 4H6v2h2V6zm0 4H6v2h2v-2z" fill="currentColor"/>
                        </svg>
                        JSON
                    </button>
                    <button class="toggle-btn active" data-view="text" onclick="window.toggleStreamView('text')">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                            <path d="M2 3h12v2H2V3zm0 4h12v2H2V7zm0 4h8v2H2v-2z" fill="currentColor"/>
                        </svg>
                        Accumulated Text
                    </button>
                </div>
            </div>

            <!-- JSON 视图 -->
            <div class="stream-view" data-view="json" style="display: none;">
                <div class="stream-chunks-container">
                    ${chunks.map((chunk, idx) => {
                        return `
                            <div class="stream-chunk">
                                <span class="chunk-index">#${idx + 1}</span>
                                <div class="chunk-content">
                                    ${renderJsonTree(chunk, { maxDepth: 2 })}
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>

            <!-- 累积文本视图 -->
            <div class="stream-view" data-view="text">
                <div class="accumulated-text-container">
                    ${renderAccumulatedText(chunks)}
                </div>
            </div>
        </div>
    `;
}

/**
 * 渲染累积文本
 */
function renderAccumulatedText(chunks) {
    let accumulatedText = '';
    const metadata = [];

    chunks.forEach((chunk, idx) => {
        // 提取文本内容
        const text = extractTextFromChunk(chunk);
        if (text) {
            accumulatedText += text;
        }

        // 提取元数据
        const meta = extractMetadataFromChunk(chunk);
        if (meta) {
            metadata.push({ index: idx + 1, ...meta });
        }
    });

    let html = '';

    // 显示累积的文本
    if (accumulatedText) {
        html += `
            <div class="accumulated-text-box">
                <div class="accumulated-text-header">
                    <span class="accumulated-text-icon">📝</span>
                    <span class="accumulated-text-title">Accumulated Content</span>
                </div>
                <div class="accumulated-text-content">${escapeHtml(accumulatedText)}</div>
            </div>
        `;
    }

    // 显示元数据
    if (metadata.length > 0) {
        html += `
            <div class="stream-metadata-box">
                <div class="stream-metadata-header">
                    <span class="metadata-icon">📊</span>
                    <span class="metadata-title">Stream Metadata</span>
                </div>
                <div class="stream-metadata-list">
                    ${metadata.map(meta => `
                        <div class="metadata-item-row">
                            <span class="metadata-chunk-index">#${meta.index}</span>
                            <span class="metadata-label">${meta.label}:</span>
                            <span class="metadata-value">${meta.value}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    return html || '<div class="loading-state"><span>No text content found</span></div>';
}

/**
 * 从 chunk 中提取文本内容
 */
function extractTextFromChunk(chunk) {
    if (typeof chunk === 'string') {
        return chunk;
    }

    // OpenAI 格式
    const delta = chunk.delta || chunk.choices?.[0]?.delta;
    if (delta?.content) {
        return delta.content;
    }

    // Anthropic 格式 - content_block_delta
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        return chunk.delta.text;
    }

    return null;
}

/**
 * 从 chunk 中提取元数据
 */
function extractMetadataFromChunk(chunk) {
    if (typeof chunk === 'string') {
        return null;
    }

    // Stop reason
    if (chunk.delta?.stop_reason || chunk.choices?.[0]?.finish_reason) {
        return {
            label: 'Stop Reason',
            value: chunk.delta?.stop_reason || chunk.choices?.[0]?.finish_reason
        };
    }

    // Usage
    if (chunk.usage) {
        const usage = chunk.usage;
        return {
            label: 'Token Usage',
            value: `Input: ${usage.input_tokens || 0}, Output: ${usage.output_tokens || 0}, Total: ${(usage.input_tokens || 0) + (usage.output_tokens || 0)}`
        };
    }

    // Message start
    if (chunk.type === 'message_start') {
        return {
            label: 'Event',
            value: 'Message Start'
        };
    }

    // Message stop
    if (chunk.type === 'message_stop') {
        return {
            label: 'Event',
            value: 'Message Complete'
        };
    }

    // Content block start
    if (chunk.type === 'content_block_start') {
        return {
            label: 'Event',
            value: `Content Block Start (${chunk.content_block?.type || 'unknown'})`
        };
    }

    // Content block stop
    if (chunk.type === 'content_block_stop') {
        return {
            label: 'Event',
            value: 'Content Block Stop'
        };
    }

    // Tool calls
    const toolCalls = chunk.delta?.tool_calls || chunk.choices?.[0]?.delta?.tool_calls;
    if (toolCalls) {
        return {
            label: 'Tool Call',
            value: JSON.stringify(toolCalls)
        };
    }

    return null;
}

/**
 * 切换流式视图
 */
window.toggleStreamView = function(view) {
    // 更新按钮状态
    document.querySelectorAll('.stream-view-toggle .toggle-btn').forEach(btn => {
        if (btn.dataset.view === view) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    // 切换视图
    document.querySelectorAll('.stream-view').forEach(viewEl => {
        if (viewEl.dataset.view === view) {
            viewEl.style.display = 'block';
        } else {
            viewEl.style.display = 'none';
        }
    });
};

/**
 * 渲染协议转换对比
 */
function renderConversionSection(detail) {
    return `
        <div class="trace-section">
            <h3 class="trace-section-title">
                <span class="section-icon">🔄</span>
                Protocol Conversion
            </h3>

            <h4 style="margin: 2rem 0 1rem; color: var(--monitor-text); font-size: 1.125rem;">Request Conversion</h4>
            <div class="comparison-container">
                <div class="comparison-panel">
                    <div class="comparison-header">Original (${detail.from_provider})</div>
                    <div class="comparison-content">
                        ${renderJsonTree(detail.original_request)}
                    </div>
                </div>
                <div class="comparison-panel">
                    <div class="comparison-header">Processed (${detail.to_provider})</div>
                    <div class="comparison-content">
                        ${renderJsonTree(detail.processed_request)}
                    </div>
                </div>
            </div>

            ${detail.native_response && detail.converted_response ? `
                <h4 style="margin: 2rem 0 1rem; color: var(--monitor-text); font-size: 1.125rem;">Response Conversion</h4>
                <div class="comparison-container">
                    <div class="comparison-panel">
                        <div class="comparison-header">Native Response</div>
                        <div class="comparison-content">
                            ${renderJsonTree(detail.native_response)}
                        </div>
                    </div>
                    <div class="comparison-panel">
                        <div class="comparison-header">Converted Response</div>
                        <div class="comparison-content">
                            ${renderJsonTree(detail.converted_response)}
                        </div>
                    </div>
                </div>
            ` : ''}
        </div>
    `;
}

/**
 * 关闭详情模态框
 */
function closeDetailModal() {
    const modal = document.getElementById('aiMonitorDetailModal');
    if (modal) {
        modal.style.display = 'none';
        currentSection = 'metadata';
    }
}

/**
 * 处理过滤器变化
 */
function handleFilterChange() {
    currentFilters.status = document.getElementById('statusFilter')?.value || '';
    currentFilters.provider = document.getElementById('providerFilter')?.value || '';
    currentPage = 0;
    loadRequests();
}

/**
 * 翻页
 */
function changePage(delta) {
    currentPage = Math.max(0, currentPage + delta);
    loadRequests();
}

/**
 * 更新分页信息
 */
function updatePagination(pagination) {
    const prevBtn = document.getElementById('prevPageBtn');
    const nextBtn = document.getElementById('nextPageBtn');
    const pageInfo = document.getElementById('pageInfo');

    if (prevBtn) prevBtn.disabled = currentPage === 0;
    if (nextBtn) nextBtn.disabled = pagination.count < pageSize;
    if (pageInfo) pageInfo.textContent = `Page ${currentPage + 1}`;
}

/**
 * 更新统计信息
 */
function updateStats(count) {
    const badge = document.getElementById('totalRequests');
    if (badge) {
        badge.textContent = `${count} request${count !== 1 ? 's' : ''}`;
    }
}

/**
 * 处理清理旧记录
 */
async function handleCleanup() {
    const days = prompt('Keep records from the last N days:', '7');
    if (!days) return;

    try {
        const response = await fetch('/api/ai-monitor/cleanup', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`
            },
            body: JSON.stringify({ daysToKeep: parseInt(days) })
        });

        if (!response.ok) throw new Error('Cleanup failed');

        const result = await response.json();
        alert(`✅ Cleaned up ${result.data.deletedCount} records`);
        loadRequests();
    } catch (error) {
        console.error('Cleanup failed:', error);
        alert('❌ Cleanup failed: ' + error.message);
    }
}

/**
 * 工具函数
 */
function formatTimestamp(ts) {
    const date = new Date(ts);
    const now = new Date();
    const diff = now - date;

    // 小于 1 分钟
    if (diff < 60000) {
        return 'Just now';
    }
    // 小于 1 小时
    if (diff < 3600000) {
        const mins = Math.floor(diff / 60000);
        return `${mins} min${mins > 1 ? 's' : ''} ago`;
    }
    // 小于 24 小时
    if (diff < 86400000) {
        const hours = Math.floor(diff / 3600000);
        return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    }

    // 否则显示完整时间
    return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 渲染 Markdown
 */
function renderMarkdown(text) {
    // 简单的 Markdown 渲染（支持常用语法）
    let html = escapeHtml(text);

    // 代码块
    html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
        return `<pre class="markdown-code-block"><code class="language-${lang || 'text'}">${code.trim()}</code></pre>`;
    });

    // 行内代码
    html = html.replace(/`([^`]+)`/g, '<code class="markdown-inline-code">$1</code>');

    // 标题
    html = html.replace(/^### (.+)$/gm, '<h3 class="markdown-h3">$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2 class="markdown-h2">$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1 class="markdown-h1">$1</h1>');

    // 粗体
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

    // 斜体
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/_(.+?)_/g, '<em>$1</em>');

    // 链接
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // 无序列表
    html = html.replace(/^\* (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul class="markdown-list">$&</ul>');

    // 有序列表
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // 换行
    html = html.replace(/\n\n/g, '</p><p class="markdown-p">');
    html = html.replace(/\n/g, '<br>');

    return `<div class="markdown-content"><p class="markdown-p">${html}</p></div>`;
}

/**
 * 切换消息视图
 */
window.toggleMessageView = function(messageId, view) {
    // 更新按钮状态
    document.querySelectorAll(`[data-message-id="${messageId}"].view-toggle-btn`).forEach(btn => {
        if (btn.dataset.view === view) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    // 切换视图
    document.querySelectorAll(`[data-message-id="${messageId}"].message-view`).forEach(viewEl => {
        if (viewEl.dataset.view === view) {
            viewEl.classList.remove('hidden');
        } else {
            viewEl.classList.add('hidden');
        }
    });
};

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}
