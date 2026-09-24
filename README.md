# Amane Stock Manager

本地桌面库存管理应用，支持扫码录入、出库阻止、JSON 本地库存文件、CSV/XLSX/JSON 导出，以及 Velopack 安装包和更新入口。

## 开发

```powershell
npm install
npm run dev
```

## 构建

```powershell
npm run build
npm run package:win
```

## Velopack 打包

```powershell
npm run velopack:pack -- -Version 0.2.3
powershell -ExecutionPolicy Bypass -File scripts/install-velopack.ps1
```

如需让应用内更新按钮可用，打包时提供 HTTPS 更新源：

```powershell
npm run velopack:pack -- -Version 0.2.3 -GithubRepoUrl "https://github.com/ZiSangMuZhi/amane-stock-manager"
```

## 管理员云端同步

v0.2.0 新增管理员登录、库存云端同步、同步进度与冲突备份、商品上架及 CAD 商店定价。登录不会自动上传本地记录，需明确选择“连接并上传当前库存”。详情见 [云端同步说明](docs/CLOUD-SYNC.md) 和 [v0.2.0 更新说明](docs/RELEASE-0.2.0.md)。

v0.2.1 修复云端库存删除后的同步：确认库存不存在时自动备份并重新上传，断网和重启继续同一次请求。详情见 [v0.2.1 更新说明](docs/RELEASE-0.2.1.md)。

v0.2.2 支持已注册商品价格同步，并连接迁移后的 `api.amaneacg.space`。卡片 CAD 售价与商店定价联动，保留进价和商店独立资料。升级后需重新登录一次。详情见 [更新说明](docs/RELEASE-0.2.2.md) 与 [同步协议](docs/SHOP-PRICE-SYNC.md)。

v0.2.3 修复迁移后可以读取库存但无法同步的来源校验问题，并对齐库存权限及错误提示。详情见 [更新说明](docs/RELEASE-0.2.3.md)。

发布前运行候选包审计，将当前版本资产与四份一致的更新源暂存到独立目录，验证后发布；不要直接上传混有历史版本的整个 `Releases` 目录。
