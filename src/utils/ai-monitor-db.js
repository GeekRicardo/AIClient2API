import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import logger from './logger.js';

/**
 * 从 metadata.user_id 中提取 session_id。
 * 兼容两种常见格式：
 *   1) Claude Code: JSON 字符串 {"device_id":"...","session_id":"<uuid>"}
 *   2) LangSmith: user_<hash>_account__session_<uuid>
 */
export function extractSessionId(userId) {
    if (!userId || typeof userId !== 'string') return null;
    const trimmed = userId.trim();
    if (trimmed.startsWith('{')) {
        try {
            const obj = JSON.parse(trimmed);
            if (obj?.session_id) return String(obj.session_id);
        } catch { /* fallthrough */ }
    }
    const m = trimmed.match(/_session_([a-zA-Z0-9-]+)/);
    return m ? m[1] : null;
}

export function extractSessionIdFromRequest(request) {
    return extractSessionId(request?.metadata?.user_id);
}

/**
 * AI Monitor 数据库管理
 * 存储 AI 请求响应的完整数据用于调试和分析
 */
class AIMonitorDB {
    constructor() {
        this.db = null;
        this.dbPath = null;
    }

    /**
     * 初始化数据库
     * @param {string} dbDir - 数据库目录，默认为 ./data
     */
    initialize(dbDir = 'data') {
        try {
            // 确保数据目录存在
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
            }

            this.dbPath = path.join(dbDir, 'ai-monitor.db');
            this.db = new Database(this.dbPath);

            // 启用 WAL 模式以提高并发性能
            this.db.pragma('journal_mode = WAL');

            this.createTables();
            this.runMigrations();
            logger.info('[AI Monitor DB] Database initialized:', this.dbPath);
        } catch (error) {
            logger.error('[AI Monitor DB] Failed to initialize database:', error.message);
            throw error;
        }
    }

    /**
     * 创建数据表
     */
    createTables() {
        // 主表：存储请求元数据
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS ai_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                request_id TEXT UNIQUE NOT NULL,
                timestamp INTEGER NOT NULL,
                from_provider TEXT,
                to_provider TEXT,
                model TEXT,
                is_stream INTEGER DEFAULT 0,
                status TEXT DEFAULT 'pending',
                error_message TEXT,
                duration_ms INTEGER,
                prompt_tokens INTEGER,
                completion_tokens INTEGER,
                total_tokens INTEGER,
                user_query_preview TEXT,
                session_id TEXT,
                created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
            );

            CREATE INDEX IF NOT EXISTS idx_request_id ON ai_requests(request_id);
            CREATE INDEX IF NOT EXISTS idx_timestamp ON ai_requests(timestamp);
            CREATE INDEX IF NOT EXISTS idx_status ON ai_requests(status);
            CREATE INDEX IF NOT EXISTS idx_session_id ON ai_requests(session_id);
        `);

        // 详情表：存储完整的请求响应 JSON
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS ai_request_details (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                request_id TEXT UNIQUE NOT NULL,
                original_request TEXT,
                processed_request TEXT,
                native_response TEXT,
                converted_response TEXT,
                stream_chunks TEXT,
                FOREIGN KEY (request_id) REFERENCES ai_requests(request_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_detail_request_id ON ai_request_details(request_id);
        `);
    }

    hasColumn(table, column) {
        const info = this.db.prepare(`PRAGMA table_info(${table})`).all();
        return info.some(col => col.name === column);
    }

    /**
     * 运行 schema 迁移（幂等）
     */
    runMigrations() {
        // 向老库补齐 session_id 列
        if (!this.hasColumn('ai_requests', 'session_id')) {
            logger.info('[AI Monitor DB] Migrating: adding session_id column');
            this.db.exec('ALTER TABLE ai_requests ADD COLUMN session_id TEXT');
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_session_id ON ai_requests(session_id)');
        }

        // 回填 session_id —— 仅处理值为空的行
        const needsBackfill = this.db.prepare('SELECT COUNT(*) as c FROM ai_requests WHERE session_id IS NULL').get();
        if (needsBackfill.c > 0) {
            logger.info(`[AI Monitor DB] Migrating: backfilling session_id for ${needsBackfill.c} rows`);
            const rows = this.db.prepare(`
                SELECT r.request_id, d.original_request
                FROM ai_requests r
                LEFT JOIN ai_request_details d ON r.request_id = d.request_id
                WHERE r.session_id IS NULL AND d.original_request IS NOT NULL
            `).all();

            const update = this.db.prepare('UPDATE ai_requests SET session_id = ? WHERE request_id = ?');
            let updated = 0;
            const tx = this.db.transaction((items) => {
                for (const row of items) {
                    try {
                        const req = JSON.parse(row.original_request);
                        const sid = extractSessionIdFromRequest(req);
                        if (sid) {
                            update.run(sid, row.request_id);
                            updated++;
                        }
                    } catch { /* skip malformed */ }
                }
            });
            tx(rows);
            logger.info(`[AI Monitor DB] Backfilled session_id for ${updated} / ${rows.length} rows`);
        }
    }

    /**
     * 插入或更新请求记录
     */
    upsertRequest(data) {
        const stmt = this.db.prepare(`
            INSERT INTO ai_requests (
                request_id, timestamp, from_provider, to_provider, model, is_stream, status, user_query_preview, session_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(request_id) DO UPDATE SET
                from_provider = excluded.from_provider,
                to_provider = excluded.to_provider,
                model = excluded.model,
                is_stream = excluded.is_stream,
                status = excluded.status,
                user_query_preview = excluded.user_query_preview,
                session_id = COALESCE(excluded.session_id, session_id)
        `);

        stmt.run(
            data.request_id,
            data.timestamp || Date.now(),
            data.from_provider,
            data.to_provider,
            data.model,
            data.is_stream ? 1 : 0,
            data.status || 'pending',
            data.user_query_preview || null,
            data.session_id || null
        );
    }

    /**
     * 更新请求状态和性能数据
     */
    updateRequestStatus(requestId, status, errorMessage = null, durationMs = null, tokenUsage = null) {
        const stmt = this.db.prepare(`
            UPDATE ai_requests
            SET status = ?, error_message = ?, duration_ms = ?,
                prompt_tokens = ?, completion_tokens = ?, total_tokens = ?
            WHERE request_id = ?
        `);

        stmt.run(
            status,
            errorMessage,
            durationMs,
            tokenUsage?.prompt_tokens || null,
            tokenUsage?.completion_tokens || null,
            tokenUsage?.total_tokens || null,
            requestId
        );
    }

    /**
     * 插入或更新请求详情
     */
    upsertRequestDetails(requestId, details) {
        const stmt = this.db.prepare(`
            INSERT INTO ai_request_details (
                request_id, original_request, processed_request,
                native_response, converted_response, stream_chunks
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(request_id) DO UPDATE SET
                original_request = COALESCE(excluded.original_request, original_request),
                processed_request = COALESCE(excluded.processed_request, processed_request),
                native_response = COALESCE(excluded.native_response, native_response),
                converted_response = COALESCE(excluded.converted_response, converted_response),
                stream_chunks = COALESCE(excluded.stream_chunks, stream_chunks)
        `);

        stmt.run(
            requestId,
            details.original_request ? JSON.stringify(details.original_request) : null,
            details.processed_request ? JSON.stringify(details.processed_request) : null,
            details.native_response ? JSON.stringify(details.native_response) : null,
            details.converted_response ? JSON.stringify(details.converted_response) : null,
            details.stream_chunks ? JSON.stringify(details.stream_chunks) : null
        );
    }

    /**
     * 查询请求列表
     */
    getRequests(options = {}) {
        const { limit = 100, offset = 0, status = null, provider = null, session_id = null } = options;

        let sql = 'SELECT * FROM ai_requests WHERE 1=1';
        const params = [];

        if (status) {
            sql += ' AND status = ?';
            params.push(status);
        }

        if (provider) {
            sql += ' AND (from_provider = ? OR to_provider = ?)';
            params.push(provider, provider);
        }

        if (session_id) {
            sql += ' AND session_id = ?';
            params.push(session_id);
        }

        sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        return this.db.prepare(sql).all(...params);
    }

    /**
     * 获取请求详情
     */
    getRequestDetail(requestId) {
        const request = this.db.prepare('SELECT * FROM ai_requests WHERE request_id = ?').get(requestId);
        if (!request) return null;

        const details = this.db.prepare('SELECT * FROM ai_request_details WHERE request_id = ?').get(requestId);

        return {
            ...request,
            is_stream: Boolean(request.is_stream),
            original_request: details?.original_request ? JSON.parse(details.original_request) : null,
            processed_request: details?.processed_request ? JSON.parse(details.processed_request) : null,
            native_response: details?.native_response ? JSON.parse(details.native_response) : null,
            converted_response: details?.converted_response ? JSON.parse(details.converted_response) : null,
            stream_chunks: details?.stream_chunks ? JSON.parse(details.stream_chunks) : null
        };
    }

    /**
     * 删除旧记录
     */
    cleanupOldRecords(daysToKeep = 7) {
        const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
        const stmt = this.db.prepare('DELETE FROM ai_requests WHERE timestamp < ?');
        const result = stmt.run(cutoffTime);
        logger.info(`[AI Monitor DB] Cleaned up ${result.changes} old records`);
        return result.changes;
    }

    /**
     * 关闭数据库连接
     */
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}

// 单例实例
const aiMonitorDB = new AIMonitorDB();

export default aiMonitorDB;
