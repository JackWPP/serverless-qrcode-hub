let KV_BINDING;
let DB;
const banPath = [
  'login', 'admin', '__total_count',
  // static files
  'admin.html', 'login.html',
  'daisyui@5.css', 'tailwindcss@4.js',
  'qr-code-styling.js', 'zxing.js',
  'robots.txt', 'wechat.svg',
  'favicon.svg',
];

// 数据库初始化
async function initDatabase() {
  // 创建表
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS mappings (
      path TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      name TEXT,
      expiry TEXT,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // 检查是否需要添加新列
  const tableInfo = await DB.prepare("PRAGMA table_info(mappings)").all();
  const columns = tableInfo.results.map(col => col.name);

  // 添加 qrCodeData1 列（如果不存在）
  if (!columns.includes('qrCodeData1')) {
    await DB.prepare(`
      ALTER TABLE mappings 
      ADD COLUMN qrCodeData1 TEXT
    `).run();
  }

  // 添加 qrCodeData2 列（如果不存在）
  if (!columns.includes('qrCodeData2')) {
    await DB.prepare(`
      ALTER TABLE mappings 
      ADD COLUMN qrCodeData2 TEXT
    `).run();
  }

  // 添加 qrOrder 列（如果不存在）
  if (!columns.includes('qrOrder')) {
    await DB.prepare(`
      ALTER TABLE mappings 
      ADD COLUMN qrOrder TEXT
    `).run();
  }

  // 移除旧的 isWechat 和 qrCodeData 列（如果存在）
  // 注意：ALTER TABLE DROP COLUMN 在某些 SQLite 版本中可能不受支持或行为有所不同。
  // Cloudflare D1 基于 SQLite，通常支持。
  if (columns.includes('isWechat')) {
    try {
      await DB.prepare(`ALTER TABLE mappings DROP COLUMN isWechat`).run();
    } catch (e) {
      console.warn("Could not drop column isWechat (it might be in use or not supported directly, consider manual migration if issues persist):", e.message);
    }
  }
  if (columns.includes('qrCodeData')) {
    try {
      await DB.prepare(`ALTER TABLE mappings DROP COLUMN qrCodeData`).run();
    } catch (e) {
      console.warn("Could not drop column qrCodeData (it might be in use or not supported directly, consider manual migration if issues persist):", e.message);
    }
  }

  // 添加索引
  await DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_expiry ON mappings(expiry)
  `).run();

  await DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_created_at ON mappings(created_at)
  `).run();

  // 组合索引：用于启用状态和过期时间的组合查询
  await DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_enabled_expiry ON mappings(enabled, expiry)
  `).run();
}

// Cookie 相关函数
function verifyAuthCookie(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const authToken = cookie.split(';').find(c => c.trim().startsWith('token='));
  if (!authToken) return false;
  return authToken.split('=')[1].trim() === env.PASSWORD;
}

function setAuthCookie(password) {
  return {
    'Set-Cookie': `token=${password}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
    'Content-Type': 'application/json'
  };
}

function clearAuthCookie() {
  return {
    'Set-Cookie': 'token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
    'Content-Type': 'application/json'
  };
}

// 数据库操作相关函数
async function listMappings(page = 1, pageSize = 10) {
  const offset = (page - 1) * pageSize;
  
  // 使用单个查询获取分页数据和总数
  const results = await DB.prepare(`
    WITH filtered_mappings AS (
      SELECT * FROM mappings 
      WHERE path NOT IN (${banPath.map(() => '?').join(',')})
    )
    SELECT 
      filtered.*,
      (SELECT COUNT(*) FROM filtered_mappings) as total_count
    FROM filtered_mappings as filtered
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).bind(...banPath, pageSize, offset).all();

  if (!results.results || results.results.length === 0) {
    return {
      mappings: {},
      total: 0,
      page,
      pageSize,
      totalPages: 0
    };
  }

  const total = results.results[0].total_count;
  const mappings = {};

  for (const row of results.results) {
    mappings[row.path] = {
      target: row.target,
      name: row.name,
      expiry: row.expiry,
      enabled: row.enabled === 1,
      qrCodeData1: row.qrCodeData1,
      qrCodeData2: row.qrCodeData2,
      qrOrder: row.qrOrder
    };
  }

  return {
    mappings,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize)
  };
}

async function createMapping(path, target, name, expiry, enabled = true, qrCodeData1 = null, qrCodeData2 = null, qrOrder = null) {
  if (!path || !target || typeof path !== 'string' || typeof target !== 'string') {
    throw new Error('Invalid input');
  }

  // 检查短链名是否在禁用列表中
  if (banPath.includes(path)) {
    throw new Error('该短链名已被系统保留，请使用其他名称');
  }

  if (expiry && isNaN(Date.parse(expiry))) {
    throw new Error('Invalid expiry date');
  }

  // 验证 qrOrder 格式 (可选, 例如, 确保是 '1,2' 或 '2,1' 如果有值)
  if (qrOrder && qrOrder.trim() !== '') { // Only validate if qrOrder is not null and not an empty string
    const parts = qrOrder.split(',');
    if (parts.length !== 2 || new Set(parts).size !== 2 || !parts.every(item => ['1', '2'].includes(item))) {
      throw new Error('Invalid qrOrder format. Must be like "1,2" or "2,1".');
    }
  }

  await DB.prepare(`
    INSERT INTO mappings (path, target, name, expiry, enabled, qrCodeData1, qrCodeData2, qrOrder)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    path,
    target,
    name || null,
    expiry || null,
    enabled ? 1 : 0,
    qrCodeData1,
    qrCodeData2,
    qrOrder
  ).run();
}

async function deleteMapping(path) {
  if (!path || typeof path !== 'string') {
    throw new Error('Invalid input');
  }

  // 检查是否在禁用列表中
  if (banPath.includes(path)) {
    throw new Error('系统保留的短链名无法删除');
  }

  await DB.prepare('DELETE FROM mappings WHERE path = ?').bind(path).run();
}

async function updateMapping(originalPath, newPath, target, name, expiry, enabled = true, qrCodeData1 = null, qrCodeData2 = null, qrOrder = null) {
  if (!originalPath || !newPath || !target) {
    throw new Error('Invalid input');
  }

  // 检查新短链名是否在禁用列表中
  if (banPath.includes(newPath)) {
    throw new Error('该短链名已被系统保留，请使用其他名称');
  }

  if (expiry && isNaN(Date.parse(expiry))) {
    throw new Error('Invalid expiry date');
  }

  // 验证 qrOrder 格式 (可选)
  if (qrOrder && qrOrder.trim() !== '') { // Only validate if qrOrder is not null and not an empty string
    const parts = qrOrder.split(',');
    if (parts.length !== 2 || new Set(parts).size !== 2 || !parts.every(item => ['1', '2'].includes(item))) {
      throw new Error('Invalid qrOrder format. Must be like "1,2" or "2,1".');
    }
  }

  // If new QR data is not provided for a slot, retain existing data for that slot.
  // This requires fetching the existing record first if partial updates are desired.
  // For simplicity in this step, we'll assume the frontend sends all three (qrCodeData1, qrCodeData2, qrOrder) 
  // or nulls for fields to be cleared. If a more granular update is needed (e.g. only update qrCodeData1),
  // this logic would need to be more complex, fetching existing values first.
  
  // Example: If you want to preserve old values if new ones are null:
  // const existing = await DB.prepare(`SELECT qrCodeData1, qrCodeData2, qrOrder FROM mappings WHERE path = ?`).bind(originalPath).first();
  // qrCodeData1 = qrCodeData1 === undefined ? existing?.qrCodeData1 : qrCodeData1;
  // qrCodeData2 = qrCodeData2 === undefined ? existing?.qrCodeData2 : qrCodeData2;
  // qrOrder = qrOrder === undefined ? existing?.qrOrder : qrOrder; 

  const stmt = DB.prepare(`
    UPDATE mappings 
    SET path = ?, target = ?, name = ?, expiry = ?, enabled = ?, qrCodeData1 = ?, qrCodeData2 = ?, qrOrder = ?
    WHERE path = ?
  `);

  await stmt.bind(
    newPath,
    target,
    name || null,
    expiry || null,
    enabled ? 1 : 0,
    qrCodeData1,
    qrCodeData2,
    qrOrder,
    originalPath
  ).run();
}

async function getExpiringMappings() {
  // 获取今天的日期（设置为今天的23:59:59）
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const now = today.toISOString();
  
  // 获取今天的开始时间（00:00:00）
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const dayStart = todayStart.toISOString();
  
  // 修改为3天后的23:59:59
  const threeDaysFromNow = new Date(todayStart);
  threeDaysFromNow.setDate(todayStart.getDate() + 3);
  threeDaysFromNow.setHours(23, 59, 59, 999);
  const threeDaysLater = threeDaysFromNow.toISOString();

  // 使用单个查询获取所有过期和即将过期的映射
  const results = await DB.prepare(`
    WITH categorized_mappings AS (
      SELECT 
        path, name, target, expiry, enabled, qrCodeData1, qrCodeData2, qrOrder,
        CASE 
          WHEN datetime(expiry) < datetime(?) THEN 'expired'
          WHEN datetime(expiry) <= datetime(?) THEN 'expiring'
        END as status
      FROM mappings 
      WHERE expiry IS NOT NULL 
        AND datetime(expiry) <= datetime(?) 
        AND enabled = 1
    )
    SELECT * FROM categorized_mappings
    ORDER BY expiry ASC
  `).bind(dayStart, threeDaysLater, threeDaysLater).all();

  const mappings = {
    expiring: [],
    expired: []
  };
  
  for (const row of results.results) {
    const mapping = {
      path: row.path,
      name: row.name,
      target: row.target,
      expiry: row.expiry,
      enabled: row.enabled === 1,
      qrCodeData1: row.qrCodeData1,
      qrCodeData2: row.qrCodeData2,
      qrOrder: row.qrOrder
    };

    if (row.status === 'expired') {
      mappings.expired.push(mapping);
    } else {
      mappings.expiring.push(mapping);
    }
  }

  return mappings;
}

// 添加新的批量清理过期映射的函数
async function cleanupExpiredMappings(batchSize = 100) {
  const now = new Date().toISOString();
  
  while (true) {
    // 获取一批过期的映射
    const batch = await DB.prepare(`
      SELECT path 
      FROM mappings 
      WHERE expiry IS NOT NULL 
        AND expiry < ? 
      LIMIT ?
    `).bind(now, batchSize).all();

    if (!batch.results || batch.results.length === 0) {
      break;
    }

    // 批量删除这些映射
    const paths = batch.results.map(row => row.path);
    const placeholders = paths.map(() => '?').join(',');
    await DB.prepare(`
      DELETE FROM mappings 
      WHERE path IN (${placeholders})
    `).bind(...paths).run();

    // 如果获取的数量小于 batchSize，说明已经处理完所有过期映射
    if (batch.results.length < batchSize) {
      break;
    }
  }
}

// 数据迁移函数
async function migrateFromKV() {
  let cursor = null;
  do {
    const listResult = await KV_BINDING.list({ cursor, limit: 1000 });
    
    for (const key of listResult.keys) {
      if (!banPath.includes(key.name)) {
        const value = await KV_BINDING.get(key.name, { type: "json" });
        if (value) {
          try {
            await createMapping(
              key.name,
              value.target,
              value.name,
              value.expiry,
              value.enabled,
              null, // qrCodeData1 - KV didn't have this
              null, // qrCodeData2 - KV didn't have this
              null  // qrOrder - KV didn't have this
            );
          } catch (e) {
            console.error(`Failed to migrate ${key.name}:`, e);
          }
        }
      }
    }
    
    cursor = listResult.cursor;
  } while (cursor);
}

export default {
  async fetch(request, env) {
    KV_BINDING = env.KV_BINDING;
    DB = env.DB;
    
    // 初始化数据库
    await initDatabase();
    
    const url = new URL(request.url);
    const path = url.pathname.slice(1);

    // 根目录跳转到 管理后台
    if (path === '') {
      return Response.redirect(url.origin + '/admin.html', 302);
    }

    // API 路由处理
    if (path.startsWith('api/')) {
      // 登录 API
      if (path === 'api/login' && request.method === 'POST') {
        const { password } = await request.json();
        if (password === env.PASSWORD) {
          return new Response(JSON.stringify({ success: true }), {
            headers: setAuthCookie(password)
          });
        }
        return new Response('Unauthorized', { status: 401 });
      }

      // 登出 API
      if (path === 'api/logout' && request.method === 'POST') {
        return new Response(JSON.stringify({ success: true }), {
          headers: clearAuthCookie()
        });
      }

      // 需要认证的 API
      if (!verifyAuthCookie(request, env)) {
        return new Response('Unauthorized', { status: 401 });
      }

      try {
        // 获取即将过期和已过期的映射
        if (path === 'api/expiring-mappings') {
          const result = await getExpiringMappings();
          return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // 获取映射列表
        if (path === 'api/mappings') {
          const params = new URLSearchParams(url.search);
          const page = parseInt(params.get('page')) || 1;
          const pageSize = parseInt(params.get('pageSize')) || 10;

          const result = await listMappings(page, pageSize);
          return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // 映射管理 API
        if (path === 'api/mapping') {
          // 获取单个映射
          if (request.method === 'GET') {
            const params = new URLSearchParams(url.search);
            const mappingPath = params.get('path');
            if (!mappingPath) {
              return new Response(JSON.stringify({ error: 'Missing path parameter' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
              });
            }

            const mapping = await DB.prepare(`
              SELECT path, target, name, expiry, enabled, qrCodeData1, qrCodeData2, qrOrder
              FROM mappings
              WHERE path = ?
            `).bind(mappingPath).first();
            if (!mapping) {
              return new Response(JSON.stringify({ error: 'Mapping not found' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' }
              });
            }

            return new Response(JSON.stringify(mapping), {
              headers: { 'Content-Type': 'application/json' }
            });
          }

          // 创建映射
          if (request.method === 'POST') {
            const data = await request.json();
            await createMapping(data.path, data.target, data.name, data.expiry, data.enabled, data.qrCodeData1, data.qrCodeData2, data.qrOrder);
            return new Response(JSON.stringify({ success: true }), {
              headers: { 'Content-Type': 'application/json' }
            });
          }

          // 更新映射
          if (request.method === 'PUT') {
            const data = await request.json();
            await updateMapping(
              data.originalPath,
              data.path,
              data.target,
              data.name,
              data.expiry,
              data.enabled,
              data.qrCodeData1,
              data.qrCodeData2,
              data.qrOrder
            );
            return new Response(JSON.stringify({ success: true }), {
              headers: { 'Content-Type': 'application/json' }
            });
          }

          // 删除映射
          if (request.method === 'DELETE') {
            const { path } = await request.json();
            await deleteMapping(path);
            return new Response(JSON.stringify({ success: true }), {
              headers: { 'Content-Type': 'application/json' }
            });
          }
        }


        return new Response('Not Found', { status: 404 });
      } catch (error) {
        console.error('API operation error:', error);
        return new Response(JSON.stringify({
          error: error.message || 'Internal Server Error'
        }), {
          status: error.message === 'Invalid input' ? 400 : 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // URL 重定向处理
    if (path) {
      try {
        const mapping = await DB.prepare(`
          SELECT path, target, name, expiry, enabled, qrCodeData1, qrCodeData2, qrOrder
          FROM mappings
          WHERE path = ?
        `).bind(path).first();
        if (mapping) {
          // 检查是否启用
          if (!mapping.enabled) {
            return new Response('Not Found', { status: 404 });
          }

          // 检查是否过期 - 使用当天23:59:59作为失效判断时间
          if (mapping.expiry) {
            const today = new Date();
            today.setHours(23, 59, 59, 999);
            if (new Date(mapping.expiry) < today) {
              const expiredHtml = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>链接已过期</title>
    <style>
        :root {
            color-scheme: light dark;
        }
        body {
            margin: 0;
            padding: 16px;
            min-height: 100vh;
            display: flex;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #f7f7f7;
            box-sizing: border-box;
        }
        .container {
            margin: auto;
            padding: 24px 16px;
            width: calc(100% - 32px);
            max-width: 320px;
            text-align: center;
            background: white;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.06);
        }
        .title {
            font-size: 22px;
            font-weight: 600;
            margin: 0 0 16px;
            color: #333;
        }
        .message {
            font-size: 16px;
            color: #666;
            margin: 16px 0;
            line-height: 1.5;
        }
        .info {
            font-size: 14px;
            color: #999;
            margin-top: 20px;
        }
        @media (prefers-color-scheme: dark) {
            body {
                background: #1a1a1a;
            }
            .container {
                background: #2a2a2a;
                box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            }
            .title {
                color: #e0e0e0;
            }
            .message {
                color: #aaa;
            }
            .info {
                color: #777;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1 class="title">${mapping.name ? mapping.name + ' 已过期' : '链接已过期'}</h1>
        <p class="info">过期时间：${new Date(mapping.expiry).toLocaleDateString()}</p>
        <p class="info">如需访问，请联系管理员更新链接</p>
    </div>
</body>
</html>`;
              return new Response(expiredHtml, {
                status: 404,
                headers: {
                  'Content-Type': 'text/html;charset=UTF-8',
                  'Cache-Control': 'no-store'
                }
              });
            }
          }

          // 生成包含多个二维码的HTML页面
          let qrCodeHtml = '';
          const qrImages = [];

          // 1. 程序生成的永久二维码 (基于 target URL)
          // 我们需要在客户端生成这个二维码，或者有一个API端点来生成它。
          // 为了简单起见，我们假设客户端将使用库来生成它。
          qrImages.push({ type: 'target', data: mapping.target, title: '永久二维码 (扫码跳转)' });

          // 2. 用户配置的二维码 (qrCodeData1 和 qrCodeData2)
          const configuredQRs = [];
          if (mapping.qrCodeData1) {
            configuredQRs.push({ id: '1', data: mapping.qrCodeData1, title: '二维码1' });
          }
          if (mapping.qrCodeData2) {
            configuredQRs.push({ id: '2', data: mapping.qrCodeData2, title: '二维码2' });
          }

          if (mapping.qrOrder && configuredQRs.length > 1) {
            const order = mapping.qrOrder.split(',');
            configuredQRs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
          }
          qrImages.push(...configuredQRs.map(qr => ({ type: 'data', data: qr.data, title: qr.title })));
          
          qrCodeHtml = qrImages.map((qr, index) => `
            <div class="qr-code-item">
              <h2>${qr.title}</h2>
              ${qr.type === 'data' ? `<img src="${qr.data}" alt="${qr.title}" class="qr-image">` : `<div id="qrcode-target-${index}" class="qr-image-placeholder"></div>`}
              ${qr.type === 'target' ? `<p class="qr-comment">${qr.data}</p>` : ''}
            </div>
          `).join('');

          const displayHtml = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${mapping.name || '二维码集合'}</title>
    <script src="/qr-code-styling.js"></script>
    <style>
        :root {
            color-scheme: light dark;
        }
        body {
            margin: 0;
            padding: 16px;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #f7f7f7;
            box-sizing: border-box;
        }
        .page-title {
            font-size: 28px;
            font-weight: 600;
            margin: 20px 0 30px;
            color: #333;
            text-align: center;
        }
        .qr-code-container {
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            gap: 30px;
        }
        .qr-code-item {
            padding: 20px;
            background: white;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.06);
            text-align: center;
            width: 300px; /* Fixed width for each QR item */
        }
        .qr-code-item h2 {
            font-size: 18px;
            font-weight: 500;
            margin: 0 0 15px;
            color: #444;
        }
        .qr-image, .qr-image-placeholder {
            width: 100%;
            max-width: 256px; /* Max width for QR code image */
            height: auto;
            min-height: 256px; /* Placeholder height */
            border-radius: 8px;
            margin-bottom: 10px;
            border: 1px solid #eee;
            display: block; /* Ensure img is block to center with margin auto */
            margin-left: auto;
            margin-right: auto;
        }
        .qr-image-placeholder {
             display: flex;
             align-items: center;
             justify-content: center;
             background-color: #f0f0f0;
        }
        .qr-comment {
            font-size: 12px;
            color: #777;
            word-break: break-all;
        }
        .info {
            font-size: 14px;
            color: #999;
            margin-top: 30px;
            text-align: center;
        }
        @media (prefers-color-scheme: dark) {
            body {
                background: #1a1a1a;
            }
            .page-title {
                color: #e0e0e0;
            }
            .qr-code-item {
                background: #2a2a2a;
                box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            }
            .qr-code-item h2 {
                color: #ccc;
            }
            .qr-image, .qr-image-placeholder {
                border: 1px solid #444;
            }
            .qr-image-placeholder {
                background-color: #3a3a3a;
            }
            .qr-comment {
                color: #888;
            }
            .info {
                color: #777;
            }
        }
    </style>
</head>
<body>
    <h1 class="page-title">${mapping.name || '扫描二维码'}</h1>
    <div class="qr-code-container">
        ${qrCodeHtml}
    </div>
    ${mapping.expiry ? `<p class="info">此链接有效期至：${new Date(mapping.expiry).toLocaleDateString()}</p>` : ''}
    <script>
        document.addEventListener('DOMContentLoaded', function() {
            const qrImages = ${JSON.stringify(qrImages)};
            qrImages.forEach((qr, index) => {
                if (qr.type === 'target') {
                    const qrCodeTargetElement = document.getElementById(\`qrcode-target-\${index}\`);
                    if (qrCodeTargetElement) {
                        new QRCodeStyling({
                            width: 256,
                            height: 256,
                            data: qr.data,
                            image: '/favicon.svg', // Optional: add a logo in the middle
                            dotsOptions: {
                                color: "#4267b2",
                                type: "rounded"
                            },
                            backgroundOptions: {
                                color: "#ffffff",
                            },
                            imageOptions: {
                                crossOrigin: "anonymous",
                                margin: 5
                            }
                        }).appendTo(qrCodeTargetElement);
                    }
                }
            });
        });
    </script>
</body>
</html>`;

          return new Response(displayHtml, {
            headers: {
              'Content-Type': 'text/html;charset=UTF-8',
              'Cache-Control': 'public, max-age=300' // Cache for 5 minutes
            }
          });
        }
        return new Response('Not Found', { status: 404 });
      } catch (error) {
        console.error('Redirect error:', error);
        return new Response('Internal Server Error', { status: 500 });
      }
    }
  },

  async scheduled(controller, env, ctx) {
    KV_BINDING = env.KV_BINDING;
    DB = env.DB;
    
    // 初始化数据库
    await initDatabase();
        
    // 获取过期和即将过期的映射报告
    const result = await getExpiringMappings();

    console.log(`Cron job report: Found ${result.expired.length} expired mappings`);
    if (result.expired.length > 0) {
      console.log('Expired mappings:', JSON.stringify(result.expired, null, 2));
    }

    console.log(`Found ${result.expiring.length} mappings expiring in 2 days`);
    if (result.expiring.length > 0) {
      console.log('Expiring soon mappings:', JSON.stringify(result.expiring, null, 2));
    }
  },

};