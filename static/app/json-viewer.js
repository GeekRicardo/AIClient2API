/**
 * 简单的 JSON 查看器 - 支持折叠展开
 */

/**
 * 渲染可折叠的 JSON 树
 */
export function renderJsonTree(data, options = {}) {
    const {
        maxDepth = 3,
        startCollapsed = false,
        showCopyButton = true
    } = options;

    const containerId = `json-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const html = `
        <div class="json-viewer">
            ${showCopyButton ? `
                <div class="json-viewer-header">
                    <button class="json-copy-btn" data-json='${JSON.stringify(data).replace(/'/g, "&#39;")}'>
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                            <path d="M4 4h8v8H4V4zm1 1v6h6V5H5z" fill="currentColor"/>
                            <path d="M2 2h8v1H3v7H2V2z" fill="currentColor"/>
                        </svg>
                        Copy
                    </button>
                </div>
            ` : ''}
            <div class="json-tree" id="${containerId}">
                ${renderJsonNode(data, 0, maxDepth, startCollapsed)}
            </div>
        </div>
    `;

    return html;
}

/**
 * 渲染 JSON 节点
 */
function renderJsonNode(data, depth, maxDepth, forceCollapsed) {
    if (data === null) {
        return `<span class="json-null">null</span>`;
    }

    if (data === undefined) {
        return `<span class="json-undefined">undefined</span>`;
    }

    const type = typeof data;

    if (type === 'boolean') {
        return `<span class="json-boolean">${data}</span>`;
    }

    if (type === 'number') {
        return `<span class="json-number">${data}</span>`;
    }

    if (type === 'string') {
        return `<span class="json-string">"${escapeHtml(data)}"</span>`;
    }

    if (Array.isArray(data)) {
        if (data.length === 0) {
            return `<span class="json-bracket">[]</span>`;
        }

        const shouldCollapse = forceCollapsed || depth >= maxDepth;
        const toggleId = `toggle-${Math.random().toString(36).substr(2, 9)}`;

        return `
            <span class="json-bracket">[</span>
            <span class="json-toggle ${shouldCollapse ? 'collapsed' : ''}" data-toggle-id="${toggleId}">
                <button class="json-toggle-btn" onclick="window.toggleJsonNode('${toggleId}')">
                    ${shouldCollapse ? '▶' : '▼'}
                </button>
                <span class="json-length">${data.length} items</span>
            </span>
            <div class="json-children ${shouldCollapse ? 'hidden' : ''}" data-children-id="${toggleId}">
                ${data.map((item, index) => `
                    <div class="json-item">
                        <span class="json-key">${index}:</span>
                        ${renderJsonNode(item, depth + 1, maxDepth, forceCollapsed)}${index < data.length - 1 ? ',' : ''}
                    </div>
                `).join('')}
            </div>
            <span class="json-bracket">]</span>
        `;
    }

    if (type === 'object') {
        const keys = Object.keys(data);
        if (keys.length === 0) {
            return `<span class="json-bracket">{}</span>`;
        }

        const shouldCollapse = forceCollapsed || depth >= maxDepth;
        const toggleId = `toggle-${Math.random().toString(36).substr(2, 9)}`;

        return `
            <span class="json-bracket">{</span>
            <span class="json-toggle ${shouldCollapse ? 'collapsed' : ''}" data-toggle-id="${toggleId}">
                <button class="json-toggle-btn" onclick="window.toggleJsonNode('${toggleId}')">
                    ${shouldCollapse ? '▶' : '▼'}
                </button>
                <span class="json-length">${keys.length} keys</span>
            </span>
            <div class="json-children ${shouldCollapse ? 'hidden' : ''}" data-children-id="${toggleId}">
                ${keys.map((key, index) => `
                    <div class="json-item">
            <span class="json-key">"${escapeHtml(key)}":</span>
                        ${renderJsonNode(data[key], depth + 1, maxDepth, forceCollapsed)}${index < keys.length - 1 ? ',' : ''}
                    </div>
                `).join('')}
            </div>
            <span class="json-bracket">}</span>
        `;
    }

    return `<span class="json-unknown">${String(data)}</span>`;
}

/**
 * 切换 JSON 节点展开/折叠
 */
window.toggleJsonNode = function(toggleId) {
    const toggle = document.querySelector(`[data-toggle-id="${toggleId}"]`);
    const children = document.querySelector(`[data-children-id="${toggleId}"]`);
    const btn = toggle?.querySelector('.json-toggle-btn');

    if (!toggle || !children || !btn) return;

    const isCollapsed = toggle.classList.contains('collapsed');

    if (isCollapsed) {
        toggle.classList.remove('collapsed');
        children.classList.remove('hidden');
        btn.textContent = '▼';
    } else {
        toggle.classList.add('collapsed');
        children.classList.add('hidden');
        btn.textContent = '▶';
    }
};

/**
 * 初始化 JSON 查看器
 */
export function initJsonViewers(parentElement = document) {
    // 绑定复制按钮
    parentElement.querySelectorAll('.json-copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const jsonData = btn.dataset.json;
            navigator.clipboard.writeText(JSON.stringify(JSON.parse(jsonData), null, 2));

            const originalHtml = btn.innerHTML;
            btn.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path d="M13 4L6 11 3 8" stroke="currentColor" stroke-width="2" fill="none"/>
                </svg>
                Copied!
            `;
            setTimeout(() => {
                btn.innerHTML = originalHtml;
            }, 2000);
        });
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
