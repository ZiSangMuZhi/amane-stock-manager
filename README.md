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
npm run velopack:pack -- -Version 0.2.1
powershell -ExecutionPolicy Bypass -File scripts/install-velopack.ps1
```

如需让应用内更新按钮可用，打包时提供 HTTPS 更新源：

```powershell
npm run velopack:pack -- -Version 0.2.1 -GithubRepoUrl "https://github.com/ZiSangMuZhi/amane-stock-manager" -PublishGitHub
```

## 管理员云端同步

v0.2.0 新增管理员登录、库存云端同步、同步进度与冲突备份、商品上架及 CAD 商店定价。登录不会自动上传本地记录，需明确选择“连接并上传当前库存”。详情见 [云端同步说明](docs/CLOUD-SYNC.md) 和 [v0.2.0 更新说明](docs/RELEASE-0.2.0.md)。

v0.2.1 修复云端库存删除后的同步：确认库存不存在时自动备份并重新上传，断网和重启继续同一次请求。详情见 [v0.2.1 更新说明](docs/RELEASE-0.2.1.md)。
