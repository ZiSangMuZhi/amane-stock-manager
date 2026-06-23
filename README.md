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
npm run velopack:pack -- -Version 0.1.3
powershell -ExecutionPolicy Bypass -File scripts/install-velopack.ps1
```

如需让应用内更新按钮可用，打包时提供 HTTPS 更新源：

```powershell
npm run velopack:pack -- -Version 0.1.3 -GithubRepoUrl "https://github.com/ZiSangMuZhi/amane-stock-manager" -PublishGitHub
```
