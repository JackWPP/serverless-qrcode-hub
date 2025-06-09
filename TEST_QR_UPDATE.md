# QR码更新功能测试指南

## 功能概述
此文档用于测试新增的QR码更新功能，该功能允许用户在编辑模式下直接替换现有短链的微信QR码图片，无需删除重建。

## 测试前准备

### 1. 环境设置
确保已完成以下配置：
- Cloudflare D1 数据库已创建并配置
- `wrangler.toml` 中的数据库ID已正确设置
- 环境变量 `PASSWORD` 已设置用于管理员登录

### 2. 启动开发服务器
```bash
# 如果有 wrangler 工具
npm run dev

# 或者直接部署到 Cloudflare
npm run deploy
```

## 功能测试步骤

### 测试场景1：为普通短链添加QR码
1. 登录管理面板 (`http://localhost:8787/admin.html`)
2. 创建一个普通短链（不勾选"微信"选项）
3. 点击该短链的"编辑"按钮
4. 在编辑模式下，应该看到"上传二维码"选项
5. 上传一个QR码图片文件
6. 验证：
   - 短链状态应自动变为"微信"模式
   - 访问短链应显示微信QR码页面而非重定向

### 测试场景2：更换微信QR码
1. 编辑一个已有的微信短链
2. 在编辑模式下，应该看到"更换二维码"选项
3. 上传新的QR码图片
4. 验证：
   - QR码成功更换
   - 短链仍保持"微信"模式
   - 访问短链显示新的QR码

### 测试场景3：动态UI切换
1. 编辑任意短链
2. 切换"微信"选项的开关状态
3. 验证：
   - 开启时显示"更换二维码"/"上传二维码"选项
   - 关闭时隐藏QR码上传选项

## API 测试

### 更新QR码 API测试
```bash
# 测试更新QR码API（需要先获取认证cookie）
curl -X PUT http://localhost:8787/api/update-qr-code \
  -H "Content-Type: application/json" \
  -H "Cookie: token=YOUR_PASSWORD" \
  -d '{
    "path": "test-qr",
    "qrCodeData": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
  }'
```

## 验证检查清单

### 后端功能
- [ ] `/api/update-qr-code` 端点正常响应
- [ ] 输入验证正确工作（缺少参数时返回400错误）
- [ ] 不存在的短链返回404错误
- [ ] 成功更新时设置 `isWechat = 1`
- [ ] QR码数据正确存储到数据库

### 前端功能  
- [ ] 编辑模式正确显示QR码上传选项
- [ ] 微信开关切换时UI动态更新
- [ ] 文件上传成功转换为base64格式
- [ ] API调用成功后显示成功提示
- [ ] 表格数据自动刷新
- [ ] 错误处理正确显示错误信息

### 用户体验
- [ ] 文件类型限制为图片格式
- [ ] 上传过程中显示处理状态提示
- [ ] 成功/失败状态有明确的用户反馈
- [ ] 界面响应流畅，无明显延迟

### 数据库验证
```sql
-- 检查QR码数据是否正确存储
SELECT path, isWechat, LENGTH(qrCodeData) as qr_data_length
FROM mappings 
WHERE qrCodeData IS NOT NULL;
```

## 已知问题和注意事项

1. **文件大小限制**：确保上传的图片文件不要过大，建议控制在1MB以内
2. **图片格式**：支持常见的图片格式（PNG、JPG、JPEG、GIF等）
3. **Base64编码**：系统会自动将上传的图片转换为base64格式存储
4. **浏览器兼容性**：FileReader API在现代浏览器中都有良好支持

## 回滚方案
如果发现严重问题需要回滚：
1. 备份当前的 `index.js` 和 `admin.html`
2. 移除 `/api/update-qr-code` 相关代码
3. 移除前端QR码上传相关UI和JavaScript代码
4. 重新部署

## 性能考虑
- QR码数据以base64格式存储在数据库中，大量QR码可能影响数据库性能
- 考虑添加图片压缩功能以减少存储空间
- 监控数据库大小增长情况

---
测试完成后，请确保所有功能都按预期工作，并记录任何发现的问题。
