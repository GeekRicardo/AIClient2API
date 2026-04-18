import aiMonitorDB from '../utils/ai-monitor-db.js';
import logger from '../utils/logger.js';

/**
 * 获取 AI 请求列表
 */
export async function handleGetAIRequests(req, res) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const limit = parseInt(url.searchParams.get('limit')) || 100;
        const offset = parseInt(url.searchParams.get('offset')) || 0;
        const status = url.searchParams.get('status') || null;
        const provider = url.searchParams.get('provider') || null;
        const session_id = url.searchParams.get('session_id') || null;

        const requests = aiMonitorDB.getRequests({ limit, offset, status, provider, session_id });

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
            success: true,
            data: requests,
            pagination: {
                limit,
                offset,
                count: requests.length
            }
        }));
        return true;
    } catch (error) {
        logger.error('[AI Monitor API] Failed to get requests:', error);
        res.writeHead(500, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
            success: false,
            error: error.message
        }));
        return true;
    }
}

/**
 * 获取单个请求的详细信息
 */
export async function handleGetAIRequestDetail(req, res, requestId) {
    try {
        const detail = aiMonitorDB.getRequestDetail(requestId);

        if (!detail) {
            res.writeHead(404, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({
                success: false,
                error: 'Request not found'
            }));
            return true;
        }

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
            success: true,
            data: detail
        }));
        return true;
    } catch (error) {
        logger.error('[AI Monitor API] Failed to get request detail:', error);
        res.writeHead(500, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
            success: false,
            error: error.message
        }));
        return true;
    }
}

/**
 * 清理旧记录
 */
export async function handleCleanupOldRecords(req, res) {
    try {
        const body = await new Promise((resolve, reject) => {
            let data = '';
            req.on('data', chunk => data += chunk);
            req.on('end', () => {
                try {
                    resolve(data ? JSON.parse(data) : {});
                } catch (e) {
                    reject(e);
                }
            });
            req.on('error', reject);
        });

        const daysToKeep = body.daysToKeep || 7;
        const deletedCount = aiMonitorDB.cleanupOldRecords(daysToKeep);

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
            success: true,
            data: {
                deletedCount,
                daysToKeep
            }
        }));
        return true;
    } catch (error) {
        logger.error('[AI Monitor API] Failed to cleanup old records:', error);
        res.writeHead(500, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
            success: false,
            error: error.message
        }));
        return true;
    }
}
