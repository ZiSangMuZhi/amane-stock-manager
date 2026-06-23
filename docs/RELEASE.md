# Release and Installer Notes

## Local build

```powershell
npm install
npm run velopack:pack -- -Version 0.1.7
```

This creates Velopack output in `Releases/`, including `Setup.exe`, full update packages, release indexes, and portable output when supported by Velopack.

For local rebuilds of the same version, clean generated release output first:

```powershell
npm run velopack:pack -- -Version 0.1.7 -CleanOutput
```

## Updates

Build with an HTTPS update feed:

```powershell
npm run velopack:pack -- -Version 0.1.7 -GithubRepoUrl "https://github.com/ZiSangMuZhi/amane-stock-manager" -PublishGitHub
```

When `-GithubRepoUrl` is provided without `-UpdateUrl`, the build embeds the GitHub Release `latest/download/` URL as the app update feed. `-PublishGitHub` uploads the generated Velopack assets to a published GitHub Release.

## Uninstall

Velopack's Windows installer registers the app in Windows Apps & Features. Uninstall removes the installed app files managed by Velopack.

The packaged application also includes `Uninstall Amane Stock Manager.cmd`, which calls Velopack's `Update.exe --uninstall` from the install root.

The app creates an `Inventory Files` folder in the install root and uses it as the default place for user inventory JSON files. Users can still choose another location from the file dialogs.

## Install directory normalization

Use the wrapper when you need to choose an install location:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-velopack.ps1 -InstallTo "D:\"
```

The wrapper installs to `%LocalAppData%\Amane Stock Manager` by default. If the chosen path is a drive root such as `C:\` or `D:\`, it automatically appends `Amane Stock Manager` so Velopack files are placed in a dedicated app folder.

Direct Velopack calls are still supported:

```powershell
Setup.exe --installto "D:\Apps\Amane Stock Manager"
msiexec /i AmaneStockManager.msi VELOPACK_INSTALLDIR="D:\Apps\Amane Stock Manager"
```

## MSI

To also generate an MSI:

```powershell
npm run velopack:pack -- -Version 0.1.7 -Msi
```

The MSI default scope is `PerUser`. To change it at package time:

```powershell
npm run velopack:pack -- -Version 0.1.7 -Msi -InstallScope PerMachine
```
