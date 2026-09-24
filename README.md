-----

# 🔐 2FA 安全管理系统 

一个基于 Cloudflare Workers 的现代化双因素认证(2FA)管理系统，提供安全的 TOTP 代码生成、账户管理和云端备份功能。

-----

## ✨ 特性

### 🛡️ 安全特性

  * **OAuth 2.0 授权登录** - 支持第三方 OAuth 服务安全认证
  * **端到端加密** - 所有敏感数据使用 AES-GCM 加密存储
  * **JWT 会话管理** - 2小时自动过期的安全会话
  * **速率限制保护** - 防止暴力攻击和 API 滥用
  * **安全审计日志** - 记录所有重要操作和安全事件

### 📱 2FA 管理

  * **多种添加方式** - 手动输入、二维码扫描、图片上传
  * **TOTP 代码生成** - 支持 6/8 位验证码，30/60 秒周期
  * **智能账户分类** - 自定义分类标签和快速搜索
  * **实时代码显示** - 带进度条的验证码倒计时
  * **一键复制功能** - 自动复制验证码到剪贴板

### ☁️ 云端备份

  * **WebDAV 自动备份** - 支持 Nextcloud、ownCloud、TeraCloud 等
  * **多账号管理** - 可配置多个 WebDAV 存储账号
  * **加密备份文件** - 密码保护的备份文件
  * **智能目录结构** - 按年/月/日自动组织备份文件
  * **备份历史管理** - 查看、下载、恢复历史备份

### 📥📤 数据迁移

  * **多格式导入** - 支持 JSON、2FAS、纯文本格式
  * **加密导出** - 密码保护的安全导出
  * **批量操作** - 支持批量导入和去重处理
  * **数据验证** - 严格的数据格式验证和清理

-----

## 🚀 快速开始

### 使用 GitHub 登录，在 Cloudflare 控制台部署

本项目的页面和接口都在 `_worker.js` 中，无需构建。当前版本会根据
`OAUTH_BASE_URL=https://github.com` 自动使用 GitHub OAuth 接口。

1. **创建 Worker 并部署代码**

   在 Cloudflare **Workers & Pages** 创建 Worker（也可使用已有 Worker），
   打开 **Edit code**，将 `_worker.js` 的全部内容替换到入口文件，点击 **Deploy**。
   记下实际访问地址，例如 `https://2fa-secure-manager.your-subdomain.workers.dev`。
   如使用自定义域名，请先绑定域名，以下地址统一使用该域名。

2. **创建并绑定 KV**

   在 Cloudflare **Workers KV** 创建命名空间，例如 `2fa-user-data`。
   打开 Worker 的 **Bindings**，添加 KV Namespace 绑定，变量名必须是 `USER_DATA`，
   选择刚创建的命名空间。

3. **创建 GitHub OAuth App**

   打开 https://github.com/settings/applications/new ，填写：

   - **Application name**：自定，例如 `My 2FA`。
   - **Homepage URL**：Worker 的完整 HTTPS 地址。
   - **Authorization callback URL**：`https://你的域名/api/oauth/callback`。

   注册后记下 **Client ID**，点击 **Generate a new client secret** 并保存密钥。
   创建的是 OAuth App，不是 GitHub App，也不需要 Personal Access Token。

4. **获取自己的 GitHub 数字用户 ID**

   浏览器打开 `https://api.github.com/users/你的GitHub用户名`，找到顶层 `id` 字段。
   `OAUTH_ID` 填这个数字的文本值，例如 `12345678`，不是用户名、`node_id` 或 Client ID。
   当前应用只允许这个用户登录。

5. **设置 Worker 变量**

   在 **Settings → Variables and Secrets** 中添加：

   | 名称 | 类型 | 值 |
   | :--- | :--- | :--- |
   | `OAUTH_BASE_URL` | Text | `https://github.com` |
   | `OAUTH_CLIENT_ID` | Secret | GitHub OAuth App 的 Client ID |
   | `OAUTH_CLIENT_SECRET` | Secret | GitHub OAuth App 的 Client Secret |
   | `OAUTH_REDIRECT_URI` | Text | `https://你的域名/api/oauth/callback` |
   | `OAUTH_ID` | Text | 你的 GitHub 数字用户 ID |
   | `JWT_SECRET` | Secret | 独立生成的随机密钥 |
   | `ENCRYPTION_KEY` | Secret | 另一串独立生成的随机密钥 |
   | `ALLOWED_ORIGINS` | Text | `https://你的域名`，末尾不加 `/` |

   在本机运行两次 `openssl rand -hex 32`，分别生成 `JWT_SECRET` 和 `ENCRYPTION_KEY`。
   妥善保存 `ENCRYPTION_KEY`：更换它不会自动迁移数据，已有数据将无法解密。
   GitHub OAuth App 的回调地址必须与 `OAUTH_REDIRECT_URI` 完全一致。

6. **保存并部署配置，验证登录**

   访问首页，点击“第三方授权登录”，应跳转到 GitHub；授权后返回应用。
   添加测试账户并刷新页面，确认账户可以读取。
   应用不请求仓库权限或私有邮箱权限，GitHub 未公开邮箱时，页面邮箱为空是正常情况。

### 使用 Wrangler CLI 部署

需要 Node.js 22 或更新版本。仓库已提供 `wrangler.toml`，入口是 `_worker.js`。

```bash
npx wrangler login
npx wrangler kv namespace create USER_DATA
```

将命令返回的 namespace ID 填入 `wrangler.toml` 的 `id`，并替换所有
`YOUR_WORKER`、`YOUR_SUBDOMAIN`、`YOUR_GITHUB_USER_ID` 占位符。
`name` 应与目标 Worker 名称一致。如果部署到已有 Worker，请保留实际使用的 KV 绑定和配置。

完成上述 GitHub OAuth App 注册后，逐条设置密钥：

```bash
npx wrangler secret put OAUTH_CLIENT_ID
npx wrangler secret put OAUTH_CLIENT_SECRET
npx wrangler secret put JWT_SECRET
npx wrangler secret put ENCRYPTION_KEY
npx wrangler deploy
```

密钥在交互提示中输入，不要提交到仓库。CLI 部署会采用 `wrangler.toml` 中的配置，
不要保留占位值，也不要混用不同域名的回调配置。

### 其他 OAuth 服务

`OAUTH_BASE_URL` 为 `https://github.com` 时使用：

- 授权：`https://github.com/login/oauth/authorize`
- 令牌：`https://github.com/login/oauth/access_token`
- 用户信息：`https://api.github.com/user`

其他地址沿用原项目的接口约定：`/oauth2/authorize`、`/oauth2/token`、`/api/user`，
用户信息需返回顶层 `id`。这不代表任意 OAuth 服务都可以直接接入；接口路径或响应结构
不同的服务需要适配。GitHub Enterprise 不在当前适配范围内。

### 常见问题

- **授权页面 404**：确认使用更新后的 `_worker.js`，且 `OAUTH_BASE_URL` 是 `https://github.com`。
- **回调地址不匹配**：检查 GitHub 应用配置、Worker 变量和实际访问域名是否一致。
- **Unauthorized user**：`OAUTH_ID` 不是当前登录 GitHub 账户的数字用户 ID。
- **Token exchange failed / No access token received**：检查 Client ID、Client Secret 和回调地址，重新从首页发起登录。
- **读取或保存账户失败**：检查 KV 绑定名是否为 `USER_DATA`，以及加密密钥是否被更换。

-----

## 📖 使用指南

### 基本操作

1.  **登录系统**

      * 点击"第三方授权登录"按钮
      * 在 OAuth 服务器完成授权
      * 自动跳转回系统主界面

2.  **添加 2FA 账户**

      * **手动添加**：输入服务名称、账户信息和 Base32 密钥
      * **扫描二维码**：使用摄像头扫描或上传二维码图片
      * **批量导入**：从其他 2FA 应用导入数据

3.  **生成验证码**

      * 点击账户卡片查看验证码
      * 验证码自动复制到剪贴板
      * 实时显示剩余有效时间

### WebDAV 备份配置

1.  **添加 WebDAV 账号**

      * 输入 WebDAV 服务器地址
      * 配置用户名和密码
      * 设置备份目录路径

2.  **自动备份**

      * 点击"立即备份"创建加密备份
      * 备份文件按日期自动组织
      * 支持多个 WebDAV 账号管理

3.  **恢复备份**

      * 查看备份文件列表
      * 选择要恢复的备份文件
      * 输入备份密码完成恢复

### 数据导入导出

#### 支持的导入格式

  * **加密备份文件** - 本系统导出的加密文件
  * **JSON 格式** - 标准 JSON 或 2FAuth 格式
  * **2FAS 格式** - 2FAS 应用的备份文件
  * **纯文本格式** - 包含 TOTP URI 的文本文件

#### 导出选项

  * **加密导出** - 密码保护的安全备份文件
  * **WebDAV 备份** - 直接上传到云存储

-----

## 🔒 安全说明

### 数据保护

  * **本地加密**：所有敏感数据在存储前使用 AES-GCM 加密
  * **传输安全**：全程 HTTPS 加密传输
  * **密钥管理**：使用强随机密钥和盐值
  * **访问控制**：基于 OAuth 2.0 的身份验证

### 隐私保护

  * **最小权限**：只请求必要的 OAuth 权限
  * **数据隔离**：每个用户的数据完全隔离
  * **会话管理**：2小时自动过期的安全会话
  * **审计日志**：记录但不存储敏感操作详情

### 安全建议

  * **强密码策略**：导出密码至少 12 个字符
  * **定期备份**：建议每周进行一次完整备份
  * **环境隔离**：生产环境使用独立的 OAuth 应用
  * **密钥轮换**：更新 JWT 密钥会使现有会话失效；更换加密密钥前必须导出备份并规划数据迁移，不能直接替换

-----

## 🛠️ 开发指南

### 项目结构

```
2fa-secure-manager/
├── _worker.js            # 页面、API 和 OAuth 登录
├── wrangler.toml         # Cloudflare Workers 配置（部署前替换占位值）
├── oauth.test.mjs        # OAuth 登录回归检查
└── README.md             # 项目文档
```

### 本地开发

  * **验证 OAuth 流程**（模拟服务响应，无需真实凭据）
    ```bash
    node --test oauth.test.mjs
    ```


  * **启动开发服务器**
    ```bash
    wrangler dev
    ```
  * **查看日志**
    ```bash
    wrangler tail
    ```
  * **测试部署**
    ```bash
    wrangler deploy --dry-run
    ```

### API 接口

#### 认证相关

  * `GET /api/oauth/authorize` - 获取 OAuth 授权 URL
  * `GET|POST /api/oauth/callback` - OAuth 回调处理

#### 账户管理

  * `GET /api/accounts` - 获取账户列表
  * `POST /api/accounts` - 添加新账户
  * `PUT /api/accounts/:id` - 更新账户信息
  * `DELETE /api/accounts/:id` - 删除账户
  * `DELETE /api/accounts/clear-all` - 清空所有账户

#### TOTP 功能

  * `POST /api/generate-totp` - 生成 TOTP 验证码
  * `POST /api/parse-uri` - 解析 TOTP URI
  * `POST /api/add-from-uri` - 从 URI 添加账户

#### 数据备份

  * `GET /api/export-secure` - 加密导出数据
  * `POST /api/import` - 导入数据
  * `POST /api/import-secure` - 导入加密数据

#### WebDAV 功能

  * `POST /api/test-webdav` - 测试 WebDAV 连接
  * `POST /api/list-webdav-backups` - 列出备份文件
  * `POST /api/export-webdav` - 导出到 WebDAV
  * `POST /api/restore-webdav` - 从 WebDAV 恢复
  * `POST /api/download-webdav` - 下载备份文件

-----

## 🤝 贡献指南

我们欢迎各种形式的贡献！

### 报告问题

如果您发现了 bug 或有功能建议，请：

  * 查看现有的 [Issues](https://www.google.com/search?q=https://github.com/your-username/2fa-secure-manager/issues)
  * 创建新的 Issue 并详细描述问题
  * 提供复现步骤和环境信息

### 提交代码

1.  Fork 本仓库
2.  创建功能分支：`git checkout -b feature/amazing-feature`
3.  提交更改：`git commit -m 'Add amazing feature'`
4.  推送分支：`git push origin feature/amazing-feature`
5.  创建 Pull Request

### 开发规范

  * 遵循现有的代码风格
  * 添加必要的注释和文档
  * 确保所有功能都有适当的错误处理
  * 遵循安全最佳实践

-----

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](https://www.google.com/search?q=LICENSE) 文件了解详情。

-----

## 🙏 致谢

  * [Cloudflare Workers](https://workers.cloudflare.com/) - 无服务器计算平台
  * [jsQR](https://github.com/cozmo/jsQR) - JavaScript 二维码解析库
  * [Web Crypto API](https://developer.mozilla.org/zh-CN/docs/Web/API/Web_Crypto_API) - 浏览器加密 API

-----

## 📞 支持

如果您需要帮助或有任何问题：

  * 📧 **邮箱**：your-email@example.com
  * 💬 **讨论**：[GitHub Discussions](https://www.google.com/search?q=https://github.com/your-username/2fa-secure-manager/discussions)
  * 🐛 **Bug 报告**：[GitHub Issues](https://www.google.com/search?q=https://github.com/your-username/2fa-secure-manager/issues)

⭐ 如果这个项目对您有帮助，请给我们一个 Star！
