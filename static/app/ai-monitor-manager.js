/**
 * AI Monitor - Langfuse 风格
 */

import { renderJsonTree, initJsonViewers } from './json-viewer.js';

const pageSize = 50;
let currentPage = 0;
let currentFilters = { status: '', provider: '', session_id: '' };
let currentSection = 'input';
let currentDetail = null;
const sectionViewMode = {};
const messageCollapsed = {};

const URL_FILTER_KEYS = ['status', 'provider', 'session_id'];

function readFiltersFromUrl() {
    const params = new URLSearchParams(window.location.search);
    URL_FILTER_KEYS.forEach(k => {
        currentFilters[k] = params.get(k) || '';
    });
}

function writeFiltersToUrl() {
    const params = new URLSearchParams(window.location.search);
    URL_FILTER_KEYS.forEach(k => {
        if (currentFilters[k]) params.set(k, currentFilters[k]);
        else params.delete(k);
    });
    const qs = params.toString();
    const url = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
    window.history.replaceState(null, '', url);
}

function applyFilterInputs() {
    const st = document.getElementById('statusFilter');
    const pv = document.getElementById('providerFilter');
    if (st) st.value = currentFilters.status || '';
    if (pv) pv.value = currentFilters.provider || '';
}

export function initAIMonitor() {
    document.getElementById('refreshRequestsBtn')?.addEventListener('click', () => {
        currentPage = 0;
        loadRequests();
    });
    document.getElementById('cleanupOldBtn')?.addEventListener('click', handleCleanup);
    document.getElementById('statusFilter')?.addEventListener('change', handleFilterChange);
    document.getElementById('providerFilter')?.addEventListener('input', debounce(handleFilterChange, 400));
    document.getElementById('prevPageBtn')?.addEventListener('click', () => changePage(-1));
    document.getElementById('nextPageBtn')?.addEventListener('click', () => changePage(1));
    document.getElementById('closeModalBtn')?.addEventListener('click', closeDetailModal);
    document.getElementById('copyRequestIdBtn')?.addEventListener('click', copyRequestId);
    document.querySelector('.lf-modal-overlay')?.addEventListener('click', closeDetailModal);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeDetailModal();
    });

    // 浏览器前进后退：重新读取 URL 并刷新列表
    window.addEventListener('popstate', () => {
        readFiltersFromUrl();
        applyFilterInputs();
        currentPage = 0;
        loadRequests();
    });

    readFiltersFromUrl();
    applyFilterInputs();
    loadRequests();
}

/* ───── 列表 ───── */

async function loadRequests() {
    const container = document.getElementById('requestsListContainer');
    if (!container) return;

    container.innerHTML = `
        <div class="lf-empty">
            <div class="lf-spinner"></div>
            <span>Loading traces…</span>
        </div>
    `;

    renderActiveFilters();

    try {
        const params = new URLSearchParams({
            limit: pageSize,
            offset: currentPage * pageSize,
            ...(currentFilters.status && { status: currentFilters.status }),
            ...(currentFilters.provider && { provider: currentFilters.provider }),
            ...(currentFilters.session_id && { session_id: currentFilters.session_id })
        });

        const response = await fetch(`/api/ai-monitor/requests?${params}`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });

        if (!response.ok) throw new Error('Failed to load requests');

        const result = await response.json();
        renderRequestsList(result.data);
        updatePagination(result.pagination);
        updateStats(result.data.length);
    } catch (error) {
        container.innerHTML = `
            <div class="lf-empty lf-empty-error">
                <span>Failed to load: ${escapeHtml(error.message)}</span>
            </div>
        `;
    }
}

function renderRequestsList(requests) {
    const container = document.getElementById('requestsListContainer');
    if (!container) return;

    if (!requests.length) {
        container.innerHTML = `<div class="lf-empty"><span>No traces found</span></div>`;
        return;
    }

    container.innerHTML = `
        <table class="lf-table">
            <thead>
                <tr>
                    <th style="width: 130px;">Time</th>
                    <th>Name</th>
                    <th>Model</th>
                    <th>Protocol</th>
                    <th style="width: 80px;">Latency</th>
                    <th style="width: 120px;">Tokens</th>
                    <th style="width: 90px;">Status</th>
                </tr>
            </thead>
            <tbody>
                ${requests.map(req => renderTableRow(req)).join('')}
            </tbody>
        </table>
    `;

    container.querySelectorAll('tr[data-request-id]').forEach(row => {
        row.addEventListener('click', () => loadRequestDetail(row.dataset.requestId));
    });
}

function renderTableRow(req) {
    const protocolTxt = req.to_provider && req.from_provider !== req.to_provider
        ? `${req.from_provider} → ${req.to_provider}`
        : req.from_provider;

    const previewText = req.user_query_preview?.trim() || req.request_id;
    const tokens = req.total_tokens
        ? `${formatNum(req.prompt_tokens || 0)} → ${formatNum(req.completion_tokens || 0)}`
        : '—';
    const latency = req.duration_ms != null ? formatDuration(req.duration_ms) : '—';

    return `
        <tr data-request-id="${escapeAttr(req.request_id)}">
            <td class="lf-cell-time">${formatTimestamp(req.timestamp)}</td>
            <td class="lf-cell-preview" title="${escapeAttr(previewText)}">
                ${escapeHtml(previewText)}
                ${req.is_stream ? '<span class="lf-tag">stream</span>' : ''}
            </td>
            <td class="lf-cell-model">${escapeHtml(req.model || '—')}</td>
            <td class="lf-cell-model">${escapeHtml(protocolTxt || '—')}</td>
            <td class="lf-cell-num">${latency}</td>
            <td class="lf-cell-num">${tokens}</td>
            <td><span class="lf-status status-${req.status}">${req.status || 'unknown'}</span></td>
        </tr>
    `;
}

/* ───── 详情 ───── */

async function loadRequestDetail(requestId) {
    const modal = document.getElementById('aiMonitorDetailModal');
    const content = document.getElementById('requestDetailContent');
    const title = document.getElementById('modalRequestId');
    if (!modal || !content || !title) return;

    modal.style.display = 'flex';
    title.textContent = requestId;
    content.innerHTML = `
        <div class="lf-empty">
            <div class="lf-spinner"></div>
            <span>Loading trace…</span>
        </div>
    `;
    document.getElementById('traceMetaBar').innerHTML = '';
    document.getElementById('traceSidebar').innerHTML = '';

    try {
        const response = await fetch(`/api/ai-monitor/requests/${encodeURIComponent(requestId)}`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });

        if (!response.ok) throw new Error('Failed to load request detail');

        const result = await response.json();
        currentDetail = result.data;
        currentSection = pickDefaultSection(currentDetail);
        renderMetaBar(currentDetail);
        renderNav(currentDetail);
        renderCurrentSection();
    } catch (error) {
        content.innerHTML = `
            <div class="lf-empty lf-empty-error">
                <span>Failed to load: ${escapeHtml(error.message)}</span>
            </div>
        `;
    }
}

function renderMetaBar(detail) {
    const bar = document.getElementById('traceMetaBar');
    if (!bar) return;

    const pills = [];

    pills.push(`<span class="lf-pill"><span class="lf-pill-label">Time:</span> ${formatTimestampFull(detail.timestamp)}</span>`);

    if (detail.duration_ms != null) {
        pills.push(`<span class="lf-pill"><span class="lf-pill-label">Latency:</span> <span class="lf-pill-mono">${formatDuration(detail.duration_ms)}</span></span>`);
    }

    const protocol = detail.to_provider && detail.from_provider !== detail.to_provider
        ? `${detail.from_provider} → ${detail.to_provider}`
        : detail.from_provider;
    if (protocol) {
        pills.push(`<span class="lf-pill"><span class="lf-pill-label">Protocol:</span> <span class="lf-pill-mono">${escapeHtml(protocol)}</span></span>`);
    }

    if (detail.model) {
        pills.push(`<span class="lf-pill lf-pill-accent"><span class="lf-pill-mono">${escapeHtml(detail.model)}</span></span>`);
    }

    if (detail.total_tokens) {
        const prompt = formatNum(detail.prompt_tokens || 0);
        const completion = formatNum(detail.completion_tokens || 0);
        const total = formatNum(detail.total_tokens);
        pills.push(`<span class="lf-pill"><span class="lf-pill-mono">${prompt} → ${completion}</span> <span class="lf-pill-label">(Σ ${total})</span></span>`);
    }

    if (detail.is_stream) {
        pills.push(`<span class="lf-pill">stream</span>`);
    }

    if (detail.session_id) {
        const active = currentFilters.session_id === detail.session_id;
        pills.push(`
            <span class="lf-pill lf-pill-session">
                <span class="lf-pill-label">Session:</span>
                <span class="lf-pill-mono" title="${escapeAttr(detail.session_id)}">${escapeHtml(detail.session_id.length > 10 ? detail.session_id.slice(0, 8) + '…' : detail.session_id)}</span>
                <button class="lf-pill-action ${active ? 'active' : ''}" data-filter-session="${escapeAttr(detail.session_id)}" title="${active ? 'Session filter active' : 'Filter by this session'}">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                        <path d="M2 3h12l-5 6v4l-2 1V9L2 3z" fill="currentColor"/>
                    </svg>
                </button>
            </span>
        `);
    }

    pills.push(`<span class="lf-status status-${detail.status}">${detail.status || 'unknown'}</span>`);

    bar.innerHTML = pills.join('');

    bar.querySelectorAll('[data-filter-session]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            applySessionFilter(btn.dataset.filterSession);
        });
    });
}

function renderNav(detail) {
    const sidebar = document.getElementById('traceSidebar');
    if (!sidebar) return;

    const messages = getMessages(detail);
    const streamChunks = getStreamChunks(detail);

    const sections = [
        { id: 'input', label: 'Input', count: null, show: true },
        { id: 'output', label: 'Output', count: null, show: !!(detail.converted_response || detail.native_response || streamChunks.length) },
        { id: 'messages', label: 'Messages', count: messages.length, show: messages.length > 0 },
        { id: 'stream', label: 'Stream', count: streamChunks.length, show: detail.is_stream && streamChunks.length > 0 },
        { id: 'conversion', label: 'Conversion', count: null, show: detail.from_provider !== detail.to_provider && !!detail.to_provider },
        { id: 'metadata', label: 'Metadata', count: null, show: true }
    ].filter(s => s.show);

    if (!sections.some(s => s.id === currentSection)) {
        currentSection = sections[0]?.id || 'input';
    }

    sidebar.innerHTML = sections.map(s => `
        <div class="lf-nav-item ${s.id === currentSection ? 'active' : ''}" data-section="${s.id}">
            <span>${s.label}</span>
            ${s.count != null ? `<span class="lf-nav-item-count">${s.count}</span>` : ''}
        </div>
    `).join('');

    sidebar.querySelectorAll('.lf-nav-item').forEach(item => {
        item.addEventListener('click', () => {
            currentSection = item.dataset.section;
            sidebar.querySelectorAll('.lf-nav-item').forEach(i => i.classList.toggle('active', i === item));
            renderCurrentSection();
        });
    });
}

function pickDefaultSection(detail) {
    if (getMessages(detail).length > 0) return 'messages';
    if (detail.converted_response || detail.native_response) return 'output';
    return 'input';
}

function renderCurrentSection() {
    const content = document.getElementById('requestDetailContent');
    if (!content || !currentDetail) return;

    let html;
    switch (currentSection) {
        case 'input':      html = renderInputSection(currentDetail); break;
        case 'output':     html = renderOutputSection(currentDetail); break;
        case 'messages':   html = renderMessagesSection(currentDetail); break;
        case 'stream':     html = renderStreamSection(currentDetail); break;
        case 'conversion': html = renderConversionSection(currentDetail); break;
        case 'metadata':   html = renderMetadataSection(currentDetail); break;
        default:           html = '';
    }

    content.innerHTML = html;
    initJsonViewers(content);
    bindSectionEvents(content);

    if (currentSection === 'messages') {
        // 默认滚动到最新消息
        requestAnimationFrame(() => { content.scrollTop = content.scrollHeight; });
    } else {
        content.scrollTop = 0;
    }
}

function bindSectionEvents(root) {
    // Formatted / JSON tabs
    root.querySelectorAll('[data-tab-group]').forEach(group => {
        const groupName = group.dataset.tabGroup;
        group.querySelectorAll('.lf-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const mode = tab.dataset.tab;
                sectionViewMode[groupName] = mode;
                group.querySelectorAll('.lf-tab').forEach(t => t.classList.toggle('active', t === tab));
                const scope = root.querySelector(`[data-tab-target="${groupName}"]`) || root;
                scope.querySelectorAll(`[data-tab-view]`).forEach(v => {
                    if (v.dataset.tabGroup && v.dataset.tabGroup !== groupName) return;
                    v.style.display = v.dataset.tabView === mode ? '' : 'none';
                });
            });
        });
    });

    // Tool call expand — 点击左侧标题/箭头区域，忽略 tabs
    root.querySelectorAll('.lf-tool-call-header').forEach(header => {
        header.addEventListener('click', (e) => {
            if (e.target.closest('.lf-tabs')) return;
            header.parentElement.classList.toggle('expanded');
        });
    });

    // Session filter 按钮（Metadata 页）
    root.querySelectorAll('[data-filter-session]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            applySessionFilter(btn.dataset.filterSession);
        });
    });

    // Message collapse toggle
    root.querySelectorAll('[data-toggle-message]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.dataset.toggleMessage;
            messageCollapsed[id] = !messageCollapsed[id];
            renderCurrentSection();
        });
    });

    // Click header (not tabs) also collapses
    root.querySelectorAll('.lf-message-header').forEach(header => {
        header.addEventListener('click', (e) => {
            if (e.target.closest('.lf-tabs')) return;
            if (e.target.closest('[data-toggle-message]')) return;
            const msg = header.closest('.lf-message');
            if (!msg) return;
            const id = msg.dataset.messageId;
            if (!id) return;
            messageCollapsed[id] = !messageCollapsed[id];
            renderCurrentSection();
        });
    });
}

/* ───── Sections ───── */

function renderInputSection(detail) {
    const request = detail.processed_request || detail.original_request;
    if (!request) return emptyCard('No input data');

    const messages = Array.isArray(request.messages) ? request.messages : [];
    const lastUser = findLastUserMessage(messages);

    if (!lastUser) {
        // 没有 user 消息就退回完整请求视图（例如 responses API 的非对话场景）
        return renderDataCard('Request Input', request, 'input');
    }

    return `
        <div class="lf-section-header">
            <h3 class="lf-section-title">Latest User Input</h3>
            <span class="lf-section-hint">turn ${messages.indexOf(lastUser) + 1} / ${messages.length}</span>
        </div>
        <div class="lf-messages">
            ${renderMessage(lastUser, 'input-latest')}
        </div>
    `;
}

function findLastUserMessage(messages) {
    // 优先找有真实文本的 user 消息（跳过纯 tool_result 包装的 user）
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== 'user') continue;
        if (typeof msg.content === 'string' && msg.content.trim()) return msg;
        if (Array.isArray(msg.content)) {
            const hasText = msg.content.some(c => c?.type === 'text' && c.text?.trim());
            if (hasText) return msg;
        }
    }
    // 兜底：最后一条 user（可能是 tool_result）
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') return messages[i];
    }
    return null;
}

function renderOutputSection(detail) {
    let response = detail.converted_response || detail.native_response;
    if (!response && detail.is_stream) {
        const chunks = getStreamChunks(detail);
        const reconstructed = reconstructAssistantMessage(chunks);
        if (reconstructed) response = reconstructed;
    }
    if (!response) return emptyCard('No output data');
    return renderDataCard('Response Output', response, 'output');
}

function renderMessagesSection(detail) {
    let messages = getMessages(detail);

    if (detail.is_stream) {
        const chunks = getStreamChunks(detail);
        const assistant = reconstructAssistantMessage(chunks);
        if (assistant) messages = [...messages, assistant];
    }

    if (!messages.length) return emptyCard('No messages');

    return `
        <div class="lf-section-header">
            <h3 class="lf-section-title">Messages <span class="lf-nav-item-count" style="margin-left: 0.375rem;">${messages.length}</span></h3>
        </div>
        <div class="lf-messages">
            ${messages.map((msg, i) => renderMessage(msg, i)).join('')}
        </div>
    `;
}

function renderMessage(msg, index = 0) {
    const role = msg.role || 'unknown';

    // OpenAI tool 消息 → 渲染成独立 tool_result
    if (role === 'tool') {
        return renderStandaloneToolResult({
            tool_use_id: msg.tool_call_id,
            content: msg.content,
            _raw: msg
        }, `${index}-0`);
    }

    // 纯 tool_result 消息（通常是 user 包装的）→ 不展示 user 外壳，只保留 tool_result 卡片
    if (Array.isArray(msg.content) && msg.content.length > 0 &&
        msg.content.every(c => c.type === 'tool_result')) {
        return msg.content.map((item, i) =>
            renderStandaloneToolResult({ ...item, _raw: msg }, `${index}-${i}`)
        ).join('');
    }

    let textContent = '';
    if (typeof msg.content === 'string') {
        textContent = msg.content;
    } else if (Array.isArray(msg.content)) {
        textContent = msg.content.filter(i => i.type === 'text').map(i => i.text).join('\n\n');
    }
    const hasText = textContent && textContent.trim().length > 0;

    // parsed view 里的附属内容（工具调用、图片、工具结果等）
    const extrasParts = [];
    if (Array.isArray(msg.content)) {
        msg.content.forEach((item, i) => {
            if (item.type === 'image_url' || item.type === 'image') {
                extrasParts.push(`<div class="lf-tool-call" data-kind="image"><div class="lf-tool-call-header"><span class="lf-tool-call-name">[image attachment]</span></div></div>`);
            } else if (item.type === 'tool_use') {
                extrasParts.push(renderInlineToolBlock({
                    kind: 'call',
                    name: item.name,
                    id: item.id,
                    data: item.input,
                    raw: item,
                    groupKey: `tcall-${index}-${i}`
                }));
            } else if (item.type === 'tool_result') {
                let data = item.content;
                if (typeof data === 'string') { try { data = JSON.parse(data); } catch { /* keep */ } }
                extrasParts.push(renderInlineToolBlock({
                    kind: 'result',
                    name: `result:${item.tool_use_id || ''}`,
                    id: item.tool_use_id,
                    data,
                    raw: item,
                    groupKey: `tres-${index}-${i}`
                }));
            }
        });
    }

    if (Array.isArray(msg.tool_calls)) {
        msg.tool_calls.forEach((tc, i) => {
            const name = tc.function?.name || tc.name;
            let args = tc.function?.arguments ?? tc.arguments ?? '{}';
            try { args = typeof args === 'string' ? JSON.parse(args) : args; } catch { /* keep */ }
            extrasParts.push(renderInlineToolBlock({
                kind: 'call',
                name,
                id: tc.id,
                data: args,
                raw: tc,
                groupKey: `tcall-fn-${index}-${i}`
            }));
        });
    }

    const extras = extrasParts.join('');
    const hasExtras = extrasParts.length > 0;
    const hasBody = hasText || hasExtras;

    const groupId = `msg-${index}-${role}`;
    const mode = sectionViewMode[groupId] || 'formatted';
    const collapsed = messageCollapsed[groupId] === true;
    const preview = (textContent.split('\n')[0] || '').slice(0, 120);

    return `
        <div class="lf-message ${collapsed ? 'collapsed' : ''}" data-role="${escapeAttr(role)}" data-message-id="${groupId}">
            <div class="lf-message-header">
                <button class="lf-message-collapse" data-toggle-message="${groupId}" title="${collapsed ? 'Expand' : 'Collapse'}">
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" class="lf-collapse-chevron">
                        <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </button>
                <span class="lf-message-role">${escapeHtml(role)}</span>
                ${collapsed && preview ? `<span class="lf-message-preview">${escapeHtml(preview)}${textContent.length > 120 ? '…' : ''}</span>` : ''}
                ${hasBody && !collapsed ? `
                    <div class="lf-tabs" data-tab-group="${groupId}" style="margin-left: auto;">
                        <button class="lf-tab ${mode === 'formatted' ? 'active' : ''}" data-tab="formatted">Parsed</button>
                        <button class="lf-tab ${mode === 'json' ? 'active' : ''}" data-tab="json">JSON</button>
                    </div>
                ` : ''}
            </div>
            <div class="lf-message-body" data-tab-target="${groupId}">
                ${hasBody ? `
                    <div data-tab-view="formatted" data-tab-group="${groupId}" style="${mode === 'formatted' ? '' : 'display:none;'}">
                        ${hasText ? renderMarkdownWithGutter(textContent) : ''}
                        ${extras}
                    </div>
                    <div data-tab-view="json" data-tab-group="${groupId}" style="${mode === 'json' ? '' : 'display:none;'}">
                        ${renderJsonTree(msg)}
                    </div>
                ` : renderJsonTree(msg)}
            </div>
        </div>
    `;
}

/**
 * tool_result 脱离 user 外壳的独立渲染（带 Parsed/JSON 切换）
 */
function renderStandaloneToolResult(item, idSuffix) {
    const groupId = `tres-std-${idSuffix}`;
    const mode = sectionViewMode[groupId] || 'formatted';
    const collapsed = messageCollapsed[groupId] === true;
    let data = item.content;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { /* keep */ } }

    const previewTxt = typeof item.content === 'string'
        ? item.content.split('\n')[0].slice(0, 120)
        : JSON.stringify(data).slice(0, 120);

    return `
        <div class="lf-message ${collapsed ? 'collapsed' : ''}" data-role="tool" data-message-id="${groupId}">
            <div class="lf-message-header">
                <button class="lf-message-collapse" data-toggle-message="${groupId}" title="${collapsed ? 'Expand' : 'Collapse'}">
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" class="lf-collapse-chevron">
                        <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </button>
                <span class="lf-message-role">tool result</span>
                ${item.tool_use_id ? `<span class="lf-tool-call-id">${escapeHtml(item.tool_use_id)}</span>` : ''}
                ${collapsed && previewTxt ? `<span class="lf-message-preview">${escapeHtml(previewTxt)}</span>` : ''}
                ${!collapsed ? `
                    <div class="lf-tabs" data-tab-group="${groupId}" style="margin-left: auto;">
                        <button class="lf-tab ${mode === 'formatted' ? 'active' : ''}" data-tab="formatted">Parsed</button>
                        <button class="lf-tab ${mode === 'json' ? 'active' : ''}" data-tab="json">JSON</button>
                    </div>
                ` : ''}
            </div>
            <div class="lf-message-body" data-tab-target="${groupId}">
                <div data-tab-view="formatted" data-tab-group="${groupId}" style="${mode === 'formatted' ? '' : 'display:none;'}">
                    ${renderToolPayload(data)}
                </div>
                <div data-tab-view="json" data-tab-group="${groupId}" style="${mode === 'json' ? '' : 'display:none;'}">
                    ${renderJsonTree(item._raw || item)}
                </div>
            </div>
        </div>
    `;
}

/**
 * Assistant 内联的 tool_call / tool_result 卡片，带 Parsed/JSON 切换
 */
function renderInlineToolBlock({ kind, name, id, data, raw, groupKey }) {
    const mode = sectionViewMode[groupKey] || 'formatted';
    const kindLabel = kind === 'result' ? 'Tool Result' : 'Tool Call';
    return `
        <div class="lf-tool-call expanded" data-kind="${kind}">
            <div class="lf-tool-call-header">
                <div class="lf-tool-call-name">
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" class="lf-tool-call-chevron">
                        <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    <span class="lf-tool-call-kind">${kindLabel}</span>
                    <span>${escapeHtml(name || '')}</span>
                    ${id ? `<span class="lf-tool-call-id">${escapeHtml(id)}</span>` : ''}
                </div>
                <div class="lf-tabs lf-tabs-sm" data-tab-group="${groupKey}">
                    <button class="lf-tab ${mode === 'formatted' ? 'active' : ''}" data-tab="formatted">Parsed</button>
                    <button class="lf-tab ${mode === 'json' ? 'active' : ''}" data-tab="json">JSON</button>
                </div>
            </div>
            <div class="lf-tool-call-body" data-tab-target="${groupKey}">
                <div data-tab-view="formatted" data-tab-group="${groupKey}" style="${mode === 'formatted' ? '' : 'display:none;'}">
                    ${renderToolPayload(data)}
                </div>
                <div data-tab-view="json" data-tab-group="${groupKey}" style="${mode === 'json' ? '' : 'display:none;'}">
                    ${renderJsonTree(raw)}
                </div>
            </div>
        </div>
    `;
}

function renderToolPayload(data) {
    if (data == null) return `<div class="lf-empty" style="padding: 0.75rem;"><span>(empty)</span></div>`;
    if (typeof data === 'string') {
        return renderPlainTextWithGutter(data);
    }
    return renderJsonTree(data);
}

/**
 * 带行号 gutter 的纯文本渲染（不解析 markdown，避免工具输出里的 *、` 等被误识别）
 */
function renderPlainTextWithGutter(text) {
    const lines = text.split('\n');
    const rows = lines.map((line, i) => {
        const content = escapeHtml(line) || '&nbsp;';
        return `<div class="lf-md-row lf-md-row-plain"><span class="lf-md-gutter">${i + 1}</span><span class="lf-md-line">${content}</span></div>`;
    });
    return `<div class="lf-md">${rows.join('')}</div>`;
}


function renderStreamSection(detail) {
    const chunks = getStreamChunks(detail);
    if (!chunks.length) return emptyCard('No stream data');

    const mode = sectionViewMode.stream || 'text';
    const accumulated = accumulateText(chunks);

    return `
        <div class="lf-section-header">
            <h3 class="lf-section-title">Stream <span class="lf-nav-item-count" style="margin-left: 0.375rem;">${chunks.length}</span></h3>
            <div class="lf-tabs" data-tab-group="stream">
                <button class="lf-tab ${mode === 'text' ? 'active' : ''}" data-tab="text">Accumulated</button>
                <button class="lf-tab ${mode === 'json' ? 'active' : ''}" data-tab="json">Chunks (${chunks.length})</button>
            </div>
        </div>
        <div data-tab-target="stream">
            <div data-tab-view="text" data-tab-group="stream" style="${mode === 'text' ? '' : 'display:none;'}">
                <div class="lf-stream-text">${accumulated ? escapeHtml(accumulated) : '<span style="color:var(--lf-text-faint);">No text content</span>'}</div>
            </div>
            <div data-tab-view="json" data-tab-group="stream" style="${mode === 'json' ? '' : 'display:none;'}">
                <div class="lf-stream-chunks">
                    ${chunks.map((chunk, idx) => `
                        <div class="lf-stream-chunk">
                            <span class="lf-stream-chunk-idx">#${idx + 1}</span>
                            <div class="lf-stream-chunk-content">${renderJsonTree(chunk, { maxDepth: 2 })}</div>
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>
    `;
}

function renderConversionSection(detail) {
    const hasResponse = detail.native_response && detail.converted_response;
    return `
        <div class="lf-section-header">
            <h3 class="lf-section-title">Protocol Conversion</h3>
        </div>
        <div class="lf-compare">
            <h4>Request</h4>
            <div class="lf-card">
                <div class="lf-card-header">Original <span class="lf-card-header-right">${escapeHtml(detail.from_provider || '')}</span></div>
                <div class="lf-card-body nopad">${renderJsonTree(detail.original_request || {})}</div>
            </div>
            <div class="lf-card">
                <div class="lf-card-header">Processed <span class="lf-card-header-right">${escapeHtml(detail.to_provider || '')}</span></div>
                <div class="lf-card-body nopad">${renderJsonTree(detail.processed_request || {})}</div>
            </div>
            ${hasResponse ? `
                <h4>Response</h4>
                <div class="lf-card">
                    <div class="lf-card-header">Native</div>
                    <div class="lf-card-body nopad">${renderJsonTree(detail.native_response)}</div>
                </div>
                <div class="lf-card">
                    <div class="lf-card-header">Converted</div>
                    <div class="lf-card-body nopad">${renderJsonTree(detail.converted_response)}</div>
                </div>
            ` : ''}
        </div>
    `;
}

function renderMetadataSection(detail) {
    const sessionActive = currentFilters.session_id === detail.session_id;
    const sessionCell = detail.session_id ? `
        <span class="lf-pill-mono" title="${escapeAttr(detail.session_id)}">${escapeHtml(detail.session_id)}</span>
        <button class="lf-btn lf-btn-sm ${sessionActive ? 'lf-btn-accent' : ''}" data-filter-session="${escapeAttr(detail.session_id)}" style="margin-left: 0.5rem;">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                <path d="M2 3h12l-5 6v4l-2 1V9L2 3z" fill="currentColor"/>
            </svg>
            ${sessionActive ? 'Filtered' : 'Filter this session'}
        </button>
    ` : null;

    const rows = [
        ['Request ID', detail.request_id, 'mono'],
        ['Session ID', sessionCell, 'raw'],
        ['Timestamp', formatTimestampFull(detail.timestamp), 'plain'],
        ['From Provider', detail.from_provider, 'mono'],
        ['To Provider', detail.to_provider, 'mono'],
        ['Model', detail.model, 'mono'],
        ['Stream', detail.is_stream ? 'yes' : 'no', 'mono'],
        ['Status', detail.status, 'plain'],
        ['Duration', detail.duration_ms != null ? `${detail.duration_ms} ms` : null, 'mono'],
        ['Prompt Tokens', detail.prompt_tokens, 'mono'],
        ['Completion Tokens', detail.completion_tokens, 'mono'],
        ['Total Tokens', detail.total_tokens, 'mono']
    ].filter(([, v]) => v != null && v !== '');

    return `
        <div class="lf-section-header">
            <h3 class="lf-section-title">Metadata</h3>
        </div>
        <div class="lf-card">
            <table class="lf-kv">
                <tbody>
                    ${rows.map(([k, v, cls]) => `
                        <tr>
                            <th>${escapeHtml(k)}</th>
                            <td class="${cls === 'plain' ? 'lf-kv-value-plain' : ''}">${cls === 'raw' ? v : escapeHtml(String(v))}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
        ${detail.error_message ? `
            <div class="lf-card" style="margin-top: 0.75rem; border-color: rgba(239, 68, 68, 0.4);">
                <div class="lf-card-header" style="color: var(--danger-color);">Error</div>
                <div class="lf-card-body"><pre style="white-space: pre-wrap; margin: 0; color: var(--danger-color); font-family: var(--lf-mono); font-size: 0.75rem;">${escapeHtml(detail.error_message)}</pre></div>
            </div>
        ` : ''}
    `;
}

/* ───── helpers ───── */

function renderDataCard(title, data, groupKey) {
    const mode = sectionViewMode[groupKey] || 'formatted';
    return `
        <div class="lf-section-header">
            <h3 class="lf-section-title">${escapeHtml(title)}</h3>
            <div class="lf-tabs" data-tab-group="${groupKey}">
                <button class="lf-tab ${mode === 'formatted' ? 'active' : ''}" data-tab="formatted">Formatted</button>
                <button class="lf-tab ${mode === 'json' ? 'active' : ''}" data-tab="json">JSON</button>
            </div>
        </div>
        <div data-tab-target="${groupKey}">
            <div data-tab-view="formatted" data-tab-group="${groupKey}" style="${mode === 'formatted' ? '' : 'display:none;'}">
                ${renderFormatted(data)}
            </div>
            <div data-tab-view="json" data-tab-group="${groupKey}" style="${mode === 'json' ? '' : 'display:none;'}">
                ${renderJsonTree(data)}
            </div>
        </div>
    `;
}

function renderFormatted(data) {
    if (!data || typeof data !== 'object') {
        return `<div class="lf-card"><div class="lf-card-body"><pre style="margin:0;white-space:pre-wrap;">${escapeHtml(String(data))}</pre></div></div>`;
    }

    const messages = Array.isArray(data.messages) ? data.messages : null;
    if (messages) {
        return `
            <div class="lf-messages">
                ${messages.map((m, i) => renderMessage(m, i)).join('')}
            </div>
            ${renderAuxFields(data)}
        `;
    }

    // Response-like object
    const choice = data.choices?.[0]?.message;
    if (choice) {
        return `
            <div class="lf-messages">${renderMessage(choice)}</div>
            ${renderJsonTree(data)}
        `;
    }
    // Anthropic response
    if (Array.isArray(data.content) && data.role) {
        return `
            <div class="lf-messages">${renderMessage(data)}</div>
            ${renderJsonTree(data)}
        `;
    }

    return renderJsonTree(data);
}

function renderAuxFields(data) {
    const aux = { ...data };
    delete aux.messages;
    if (Object.keys(aux).length === 0) return '';
    return `
        <div class="lf-card" style="margin-top: 0.75rem;">
            <div class="lf-card-header">Parameters</div>
            <div class="lf-card-body nopad">${renderJsonTree(aux)}</div>
        </div>
    `;
}

function emptyCard(msg) {
    return `<div class="lf-card"><div class="lf-card-body"><div class="lf-empty" style="padding:1.5rem;"><span>${escapeHtml(msg)}</span></div></div></div>`;
}

function getMessages(detail) {
    return detail.processed_request?.messages || detail.original_request?.messages || [];
}

function getStreamChunks(detail) {
    return detail.stream_chunks?.converted || detail.stream_chunks?.native || [];
}

function accumulateText(chunks) {
    let txt = '';
    for (const chunk of chunks) {
        const t = extractTextFromChunk(chunk);
        if (t) txt += t;
    }
    return txt;
}

function extractTextFromChunk(chunk) {
    if (typeof chunk === 'string') return chunk;
    const delta = chunk.delta || chunk.choices?.[0]?.delta;
    if (delta?.content) return delta.content;
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') return chunk.delta.text;
    return null;
}

function reconstructAssistantMessage(chunks) {
    let text = '';
    const toolCalls = [];
    for (const chunk of chunks) {
        if (chunk.choices?.[0]) {
            const d = chunk.choices[0].delta;
            if (d?.content) text += d.content;
            if (d?.tool_calls) {
                for (const tc of d.tool_calls) {
                    const i = tc.index || 0;
                    if (!toolCalls[i]) toolCalls[i] = { id: tc.id || '', type: 'function', function: { name: tc.function?.name || '', arguments: '' } };
                    if (tc.function?.name) toolCalls[i].function.name = tc.function.name;
                    if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
                }
            }
        }
        if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') text += chunk.delta.text;
        if (chunk.type === 'content_block_start' && chunk.content_block?.type === 'tool_use') {
            toolCalls.push({ id: chunk.content_block.id, type: 'tool_use', name: chunk.content_block.name, input: {}, inputJson: '' });
        }
        if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'input_json_delta') {
            const last = toolCalls[toolCalls.length - 1];
            if (last) last.inputJson = (last.inputJson || '') + chunk.delta.partial_json;
        }
    }
    if (!text && !toolCalls.length) return null;

    const msg = { role: 'assistant', content: [] };
    if (text) msg.content.push({ type: 'text', text });

    for (const tc of toolCalls) {
        if (tc.type === 'tool_use') {
            try { tc.input = tc.inputJson ? JSON.parse(tc.inputJson) : {}; } catch { tc.input = {}; }
            delete tc.inputJson;
            msg.content.push(tc);
        }
    }
    const fnCalls = toolCalls.filter(tc => tc.type === 'function');
    if (fnCalls.length) msg.tool_calls = fnCalls;

    if (msg.content.length === 0) msg.content = '';
    else if (msg.content.length === 1 && msg.content[0].type === 'text') msg.content = msg.content[0].text;

    return msg;
}

/* ───── controls ───── */

function closeDetailModal() {
    const modal = document.getElementById('aiMonitorDetailModal');
    if (modal) modal.style.display = 'none';
    currentDetail = null;
}

function copyRequestId() {
    const id = document.getElementById('modalRequestId')?.textContent;
    if (!id || id === '—') return;
    navigator.clipboard.writeText(id);
    const btn = document.getElementById('copyRequestIdBtn');
    if (!btn) return;
    const original = btn.innerHTML;
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M13 4L6 11 3 8" stroke="currentColor" stroke-width="2" fill="none"/></svg>`;
    setTimeout(() => { btn.innerHTML = original; }, 1200);
}

function handleFilterChange() {
    currentFilters.status = document.getElementById('statusFilter')?.value || '';
    currentFilters.provider = document.getElementById('providerFilter')?.value || '';
    currentPage = 0;
    writeFiltersToUrl();
    loadRequests();
}

function applySessionFilter(sessionId) {
    currentFilters.session_id = sessionId || '';
    currentPage = 0;
    writeFiltersToUrl();
    closeDetailModal();
    loadRequests();
}

function clearSessionFilter() {
    currentFilters.session_id = '';
    currentPage = 0;
    writeFiltersToUrl();
    loadRequests();
}

function renderActiveFilters() {
    const host = document.getElementById('activeFilters');
    if (!host) return;
    const pieces = [];
    if (currentFilters.session_id) {
        pieces.push(`
            <span class="lf-active-filter-chip">
                <span class="lf-active-filter-label">Session</span>
                <span class="lf-active-filter-value lf-pill-mono" title="${escapeAttr(currentFilters.session_id)}">${escapeHtml(currentFilters.session_id)}</span>
                <button class="lf-active-filter-close" data-clear="session_id" title="Clear filter">
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                        <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                    </svg>
                </button>
            </span>
        `);
    }
    if (!pieces.length) {
        host.innerHTML = '';
        host.style.display = 'none';
        return;
    }
    host.style.display = '';
    host.innerHTML = pieces.join('');
    host.querySelectorAll('[data-clear]').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.clear;
            if (key === 'session_id') clearSessionFilter();
        });
    });
}

function changePage(delta) {
    currentPage = Math.max(0, currentPage + delta);
    loadRequests();
}

function updatePagination(pagination) {
    const prev = document.getElementById('prevPageBtn');
    const next = document.getElementById('nextPageBtn');
    const info = document.getElementById('pageInfo');
    if (prev) prev.disabled = currentPage === 0;
    if (next) next.disabled = pagination.count < pageSize;
    if (info) info.textContent = `Page ${currentPage + 1}`;
}

function updateStats(count) {
    const el = document.getElementById('totalRequests');
    if (el) el.textContent = `${count} trace${count !== 1 ? 's' : ''}`;
}

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
        alert(`Cleaned up ${result.data.deletedCount} records`);
        loadRequests();
    } catch (error) {
        alert('Cleanup failed: ' + error.message);
    }
}

/* ───── utils ───── */

function formatTimestamp(ts) {
    const date = new Date(ts);
    const now = new Date();
    const diff = now - date;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatTimestampFull(ts) {
    return new Date(ts).toLocaleString(undefined, {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
}

function formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(2)}s`;
    const m = Math.floor(s / 60);
    const rem = Math.round(s - m * 60);
    return `${m}m ${rem}s`;
}

function formatNum(n) {
    if (n == null) return '—';
    return Number(n).toLocaleString();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
}

function escapeAttr(text) {
    return escapeHtml(text).replace(/"/g, '&quot;');
}

/**
 * 按行渲染 markdown，带行号 gutter，保留代码块结构
 */
function renderMarkdownWithGutter(text) {
    const lines = text.split('\n');
    let inCode = false;
    const rows = lines.map((line, i) => {
        const lineNum = i + 1;
        let content;
        let rowCls = 'lf-md-row';

        const fenceMatch = line.match(/^\s*```(\w*)\s*$/);
        if (fenceMatch) {
            inCode = !inCode;
            rowCls += ' lf-md-row-fence';
            content = `<span class="lf-md-fence-txt">${escapeHtml(line)}</span>`;
        } else if (inCode) {
            rowCls += ' lf-md-row-code';
            content = `<code>${escapeHtml(line) || '&nbsp;'}</code>`;
        } else {
            rowCls += ' lf-md-row-text';
            content = renderInlineMarkdown(line) || '&nbsp;';
        }

        return `<div class="${rowCls}"><span class="lf-md-gutter">${lineNum}</span><span class="lf-md-line">${content}</span></div>`;
    });

    return `<div class="lf-md">${rows.join('')}</div>`;
}

function renderInlineMarkdown(line) {
    if (!line) return '';

    const leadingMatch = line.match(/^(\s+)/);
    const leading = leadingMatch ? leadingMatch[0] : '';
    const rest = line.slice(leading.length);
    let html = escapeHtml(rest);

    const hMatch = html.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
        const level = hMatch[1].length;
        html = `<span class="lf-md-h lf-md-h${level}">${applyInline(hMatch[2])}</span>`;
    } else {
        const bulletMatch = html.match(/^([-*+])\s+(.+)$/);
        const orderMatch = html.match(/^(\d+)\.\s+(.+)$/);
        if (bulletMatch) {
            html = `<span class="lf-md-bullet">•</span> ${applyInline(bulletMatch[2])}`;
        } else if (orderMatch) {
            html = `<span class="lf-md-bullet">${orderMatch[1]}.</span> ${applyInline(orderMatch[2])}`;
        } else {
            html = applyInline(html);
        }
    }

    const leadingSpaces = leading.replace(/\t/g, '    ').replace(/ /g, '&nbsp;');
    return `${leadingSpaces}${html}`;
}

function applyInline(html) {
    // inline code first（避免内部语法被误解析）
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    // bold (**xx**)
    html = html.replace(/\*\*([^\n*]+?)\*\*/g, '<strong>$1</strong>');
    // italic (*xx*) — 不跨行、不冲突
    html = html.replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s.,)!?:]|$)/g, '$1<em>$2</em>');
    // links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return html;
}

function debounce(fn, wait) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), wait);
    };
}
