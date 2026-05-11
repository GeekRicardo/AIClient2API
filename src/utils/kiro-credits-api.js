/**
 * Kiro Credits API 查询模块（纯 HTTP 接口）
 * 用于 AIClient2API 提供商池管理
 */

import https from 'https';
import cbor from 'cbor';
import { promises as fs } from 'fs';

/**
 * 调用 Kiro API 获取用户使用情况
 * @param {Object} options - 配置选项
 * @param {string} options.accessToken - Kiro AccessToken
 * @param {string} options.userId - Kiro UserId
 * @param {string} options.visitorId - Kiro VisitorId (可选)
 * @returns {Promise<Object>} API 响应数据
 */
async function callKiroAPI(options) {
  const {
    accessToken,
    userId,
    visitorId = '',
    identityProvider = 'Google'
  } = options;

  if (!accessToken || !userId) {
    throw new Error('缺少必需参数: accessToken, userId');
  }

  // 构建请求体（CBOR 格式）
  // origin 只能是 KIRO_IDE / UNKNOWN / KIRO_CLI
  const requestBody = {
    origin: 'KIRO_IDE',
    isEmailRequired: false,
    profileArn: 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK'
  };

  // 编码为 CBOR
  const cborData = cbor.encode(requestBody);

  // 构建 Cookie header（Idp 是 Kiro web portal 鉴权必需 cookie，缺失会 401 "Identity provider is required"）
  const cookieHeader = [
    `AccessToken=${accessToken}`,
    `UserId=${userId}`,
    `Idp=${identityProvider}`,
    `kiro-visitor-id=${visitorId}`
  ].join('; ');

  // 构建请求选项
  const requestOptions = {
    hostname: 'app.kiro.dev',
    port: 443,
    path: '/service/KiroWebPortalService/operation/GetUserUsageAndLimits',
    method: 'POST',
    headers: {
      'Content-Type': 'application/cbor',
      'Accept': 'application/cbor',
      'Cookie': cookieHeader,
      'smithy-protocol': 'rpc-v2-cbor',
      'x-kiro-userid': userId,
      'x-kiro-visitorid': visitorId,
      'x-amz-user-agent': 'aws-sdk-js/1.0.0 ua/2.1 os/macOS lang/js md/browser m/N,M,E',
      'Content-Length': cborData.length
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(requestOptions, (res) => {
      const chunks = [];

      res.on('data', (chunk) => {
        chunks.push(chunk);
      });

      res.on('end', () => {
        try {
          const buffer = Buffer.concat(chunks);

          // 解码 CBOR 响应
          const decoded = cbor.decode(buffer);

          if (res.statusCode === 200) {
            resolve(decoded);
          } else {
            reject(new Error(`API 请求失败: ${res.statusCode} - ${JSON.stringify(decoded)}`));
          }
        } catch (error) {
          reject(new Error(`解析响应失败: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`请求失败: ${error.message}`));
    });

    req.write(cborData);
    req.end();
  });
}

/**
 * 解析 API 响应数据
 * @param {Object} apiResponse - API 原始响应
 * @returns {Object} 格式化的 credits 信息
 */
function parseAPIResponse(apiResponse) {
  const result = {
    email: null,
    userId: null,
    planType: null,
    bonusCredits: null,
    planCredits: null,
    totalUsed: 0,
    totalAvailable: 0,
    daysUntilReset: 0,
    nextDateReset: null,        // Kiro 返回的下次重置 ISO 日期，如 2026-06-01T00:00:00.000Z
    freeTrialExpiry: null,      // Free Trial 到期日期（如适用）
    subscriptionInfo: null
  };

  try {
    // 提取用户信息
    if (apiResponse.userInfo) {
      result.email = apiResponse.userInfo.email;
      result.userId = apiResponse.userInfo.userId;
    }

    // 提取订阅信息
    if (apiResponse.subscriptionInfo) {
      result.planType = apiResponse.subscriptionInfo.subscriptionTitle || 'UNKNOWN';
      result.subscriptionInfo = {
        type: apiResponse.subscriptionInfo.type,
        title: apiResponse.subscriptionInfo.subscriptionTitle,
        upgradeCapability: apiResponse.subscriptionInfo.upgradeCapability,
        overageCapability: apiResponse.subscriptionInfo.overageCapability
      };
    }

    // 提取下次重置日期：优先顶层 nextDateReset，否则用列表第一项的 nextDateReset
    const resetIso = apiResponse.nextDateReset
      || (Array.isArray(apiResponse.usageBreakdownList) && apiResponse.usageBreakdownList[0]?.nextDateReset)
      || null;
    if (resetIso) {
      result.nextDateReset = resetIso;
      const diffMs = new Date(resetIso).getTime() - Date.now();
      result.daysUntilReset = Math.max(0, Math.ceil(diffMs / 86400000));
    }

    // 解析使用情况列表
    if (apiResponse.usageBreakdownList && Array.isArray(apiResponse.usageBreakdownList)) {
      for (const item of apiResponse.usageBreakdownList) {
        // Bonus Credits (免费试用)
        if (item.freeTrialInfo) {
          const used = item.freeTrialInfo.currentUsage || 0;
          const total = item.freeTrialInfo.usageLimit || 0;
          const expiryIso = item.freeTrialInfo.freeTrialExpiry || null;
          let trialDaysLeft = result.daysUntilReset;
          if (expiryIso) {
            const ms = new Date(expiryIso).getTime() - Date.now();
            trialDaysLeft = Math.max(0, Math.ceil(ms / 86400000));
            result.freeTrialExpiry = expiryIso;
          }

          result.bonusCredits = {
            used,
            total,
            remaining: total - used,
            daysLeft: trialDaysLeft,
            expiry: expiryIso,
            percentage: total > 0 ? Math.round((used / total) * 100) : 0,
            status: item.freeTrialInfo.freeTrialStatus
          };

          result.totalUsed += used;
          result.totalAvailable += total;
        }

        // Plan Credits (订阅计划)
        if (item.usageLimit && !item.freeTrialInfo) {
          const used = item.currentUsage || 0;
          const covered = item.usageLimit || 0;

          result.planCredits = {
            used,
            covered,
            remaining: covered - used,
            percentage: covered > 0 ? Math.round((used / covered) * 100) : 0
          };

          result.totalUsed += used;
          result.totalAvailable += covered;
        }
      }
    }

    return result;
  } catch (error) {
    throw new Error(`解析 API 响应失败: ${error.message}`);
  }
}

/**
 * 查询 Kiro 账号的 credits 使用情况
 * @param {Object} options - 配置选项
 * @param {string} options.accessToken - Kiro AccessToken
 * @param {string} options.userId - Kiro UserId
 * @param {string} options.visitorId - Kiro VisitorId (可选)
 * @returns {Promise<Object>} Credits 使用情况
 */
async function getKiroCredits(options) {
  try {
    // 调用 API
    const apiResponse = await callKiroAPI(options);

    // 解析响应
    const result = parseAPIResponse(apiResponse);

    return result;
  } catch (error) {
    throw new Error(`查询 Kiro credits 失败: ${error.message}`);
  }
}

/**
 * 从 session 文件中提取 tokens 并查询 credits
 * @param {string} sessionFilePath - Session 文件路径
 * @returns {Promise<Object>} Credits 使用情况
 */
async function getKiroCreditsFromSession(sessionFilePath) {
  try {
    await fs.access(sessionFilePath);
  } catch (error) {
    throw new Error(`Session 文件不存在: ${sessionFilePath}`);
  }

  // 读取 session 文件
  const sessionData = JSON.parse(await fs.readFile(sessionFilePath, 'utf8'));

  // 提取必需的 cookies
  const cookies = sessionData.cookies || [];

  const accessTokenCookie = cookies.find(c => c.name === 'AccessToken' && c.domain === 'app.kiro.dev');
  const userIdCookie = cookies.find(c => c.name === 'UserId' && c.domain === 'app.kiro.dev');
  const visitorIdCookie = cookies.find(c => c.name === 'kiro-visitor-id');

  if (!accessTokenCookie || !userIdCookie) {
    throw new Error('Session 文件中缺少必需的 cookies (AccessToken, UserId)');
  }

  return getKiroCredits({
    accessToken: accessTokenCookie.value,
    userId: userIdCookie.value,
    visitorId: visitorIdCookie?.value || ''
  });
}

/**
 * 从 AIClient2API 提供商配置中查询 credits
 * @param {Object} providerConfig - 提供商配置
 * @param {string} providerConfig.KIRO_ACCESS_TOKEN - AccessToken
 * @param {string} providerConfig.KIRO_USER_ID - UserId
 * @param {string} providerConfig.KIRO_VISITOR_ID - VisitorId (可选)
 * @returns {Promise<Object>} Credits 使用情况
 */
async function getKiroCreditsFromProvider(providerConfig) {
  const {
    KIRO_ACCESS_TOKEN,
    KIRO_USER_ID,
    KIRO_VISITOR_ID
  } = providerConfig;

  if (!KIRO_ACCESS_TOKEN || !KIRO_USER_ID) {
    throw new Error('提供商配置中缺少必需参数: KIRO_ACCESS_TOKEN, KIRO_USER_ID');
  }

  return getKiroCredits({
    accessToken: KIRO_ACCESS_TOKEN,
    userId: KIRO_USER_ID,
    visitorId: KIRO_VISITOR_ID || ''
  });
}

export {
  getKiroCredits,
  getKiroCreditsFromSession,
  getKiroCreditsFromProvider,
  callKiroAPI,
  parseAPIResponse
};
