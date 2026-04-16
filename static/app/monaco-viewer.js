/**
 * Monaco Editor 查看器 - 用于展示 JSON 代码
 */

let monacoLoaded = false;
let monacoLoadPromise = null;

/**
 * 加载 Monaco Editor
 */
async function loadMonaco() {
    if (monacoLoaded) return;
    if (monacoLoadPromise) return monacoLoadPromise;

    monacoLoadPromise = new Promise((resolve, reject) => {
        // 配置 Monaco 加载路径
        require.config({
            paths: {
                'vs': '/node_modules/monaco-editor/min/vs'
            }
        });

        require(['vs/editor/editor.main'], function() {
            monacoLoaded = true;

            // 配置 Monaco 主题
            monaco.editor.defineTheme('ai-monitor-dark', {
                base: 'vs-dark',
                inherit: true,
                rules: [],
                colors: {
                    'editor.background': '#1a1d23',
                    'editor.foreground': '#e4e7eb',
                    'editorLineNumber.foreground': '#4b5563',
                    'editorLineNumber.activeForeground': '#9ca3af',
                    'editor.selectionBackground': '#374151',
                    'editor.inactiveSelectionBackground': '#1f2937',
                    'editorCursor.foreground': '#3b82f6',
                    'editor.lineHighlightBackground': '#1f2937',
                    'editorIndentGuide.background': '#374151',
                    'editorIndentGuide.activeBackground': '#4b5563',
                }
            });

            resolve();
        });
    });

    return monacoLoadPromise;
}

/**
 * 创建 Monaco 编辑器实例
 */
export async function createMonacoViewer(container, data, options = {}) {
    await loadMonaco();

    const code = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

    const editor = monaco.editor.create(container, {
        value: code,
        language: options.language || 'json',
        theme: 'ai-monitor-dark',
        readOnly: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        fontSize: 13,
        lineNumbers: 'on',
        folding: true,
        foldingStrategy: 'indentation',
        renderLineHighlight: 'line',
        scrollbar: {
            vertical: 'auto',
            horizontal: 'auto',
            useShadows: false,
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10
        },
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        overviewRulerBorder: false,
        lineDecorationsWidth: 0,
        lineNumbersMinChars: 4,
        glyphMargin: false,
        ...options
    });

    return editor;
}

/**
 * 渲染 Monaco 代码块
 */
export function renderMonacoCodeBlock(data, language = 'json', containerId = null) {
    const id = containerId || `monaco-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    return `
        <div class="monaco-code-block">
            <div class="monaco-header">
                <span class="monaco-language">${language}</span>
                <div class="monaco-actions">
                    <button class="monaco-copy-btn" data-container-id="${id}">
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                            <path d="M4 4h8v8H4V4zm1 1v6h6V5H5z" fill="currentColor"/>
                            <path d="M2 2h8v1H3v7H2V2z" fill="currentColor"/>
                        </svg>
                        Copy
                    </button>
                    <button class="monaco-collapse-btn" data-container-id="${id}">
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                            <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="2"/>
                        </svg>
                        Collapse All
                    </button>
                    <button class="monaco-expand-btn" data-container-id="${id}" style="display: none;">
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                            <path d="M3 8h10" stroke="currentColor" stroke-width="2"/>
                        </svg>
                        Expand All
                    </button>
                </div>
            </div>
            <div class="monaco-container" id="${id}" data-content='${JSON.stringify(data)}' data-language="${language}"></div>
        </div>
    `;
}

/**
 * 初始化所有 Monaco 编辑器
 */
export async function initializeMonacoEditors(parentElement = document) {
    const containers = parentElement.querySelectorAll('.monaco-container:not([data-initialized])');
    const editors = new Map();

    for (const container of containers) {
        try {
            const data = JSON.parse(container.dataset.content);
            const language = container.dataset.language || 'json';

            const editor = await createMonacoViewer(container, data, { language });
            editors.set(container.id, editor);

            container.dataset.initialized = 'true';
        } catch (error) {
            console.error('Failed to initialize Monaco editor:', error);
        }
    }

    // 绑定复制按钮
    parentElement.querySelectorAll('.monaco-copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const containerId = btn.dataset.containerId;
            const editor = editors.get(containerId);
            if (editor) {
                const text = editor.getValue();
                navigator.clipboard.writeText(text);
                btn.innerHTML = `
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                        <path d="M13 4L6 11 3 8" stroke="currentColor" stroke-width="2" fill="none"/>
                    </svg>
                    Copied!
                `;
                setTimeout(() => {
                    btn.innerHTML = `
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                            <path d="M4 4h8v8H4V4zm1 1v6h6V5H5z" fill="currentColor"/>
                            <path d="M2 2h8v1H3v7H2V2z" fill="currentColor"/>
                        </svg>
                        Copy
                    `;
                }, 2000);
            }
        });
    });

    // 绑定折叠/展开按钮
    parentElement.querySelectorAll('.monaco-collapse-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const containerId = btn.dataset.containerId;
            const editor = editors.get(containerId);
            if (editor) {
                editor.getAction('editor.foldAll').run();
                btn.style.display = 'none';
                parentElement.querySelector(`.monaco-expand-btn[data-container-id="${containerId}"]`).style.display = 'flex';
            }
        });
    });

    parentElement.querySelectorAll('.monaco-expand-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const containerId = btn.dataset.containerId;
            const editor = editors.get(containerId);
            if (editor) {
                editor.getAction('editor.unfoldAll').run();
                btn.style.display = 'none';
                parentElement.querySelector(`.monaco-collapse-btn[data-container-id="${containerId}"]`).style.display = 'flex';
            }
        });
    });

    return editors;
}

/**
 * 销毁所有编辑器实例
 */
export function disposeMonacoEditors(editors) {
    if (editors instanceof Map) {
        editors.forEach(editor => editor.dispose());
        editors.clear();
    }
}
