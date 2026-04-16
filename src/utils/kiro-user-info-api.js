/**
 * Kiro User Info API 查询模块
 * 用于获取用户信息（包括 userId）
 */

import https from 'https';
import cbor from 'cbor';

/**
 * 调用 Kiro GetUserInfo API 获取用户信息
 * @param {Object} options - 配置选项
 * @param {string} options.accessToken - Kiro AccessToken
 * @param {string} options.profileArn - Profile ARN (可选)
 * @returns {Promise<Object>} 用户信息
 */
export async function getKiroUserInfo(options) {
  const {
    accessToken,
    profileArn = 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK'
  } = options;

  if (!accessToken) {
    throw new Error('缺少必需参数: accessToken');
  }

  // 构建请求体（CBOR 格式）
  const requestBody = {
    origin: 'KIRO_IDE',
    profileArn
  };

  // 编码为 CBOR
  const cborData = cbor.encode(requestBody);

  // 构建 Cookie header
  const cookieHeader = `AccessToken=${accessToken}`;

  // 构建请求选项
  const requestOptions = {
    hostname: 'app.kiro.dev',
    port: 443,
    path: '/service/KiroWebPortalService/operation/GetUserInfo',
    method: 'POST',
    headers: {
      'Content-Type': 'application/cbor',
      'Accept': 'application/cbor',
      'Cookie': cookieHeader,
      'smithy-protocol': 'rpc-v2-cbor',
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
