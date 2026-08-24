# Dumper

PS1本体の512 KiB BIOSを読み、独自の8色2次元コードとして画面へ繰り返し表示します。

PSn00bSDK、Psy-QなどのSDKは使用しません。GPUレジスタ操作、起動コード、PS-X EXE生成を
このディレクトリ内で実装しています。ビルドツールとして以下は必要です。

- CMake 3.21以降
- Ninja
- `mipsel-none-elf-gcc` ツールチェーン
- Python 3.10以降（ELFからPS-X EXEへの変換には標準ライブラリだけを使用）

Windows用GCCはPSn00bSDK公式リリースの
[`gcc-mipsel-none-elf-12.3.0-windows.zip`](https://github.com/Lameguy64/PSn00bSDK/releases/download/v0.24/gcc-mipsel-none-elf-12.3.0-windows.zip)
を利用できます。SDKのライブラリは使用しません。展開先の `bin` を `PATH` に追加します。

PowerShellでは次のようにビルドします。`C:\mipsel-none-elf` は実際の展開先へ置き換えてください。

```powershell
$env:Path = "C:\mipsel-none-elf\bin;$env:Path"
cd dumper
$toolchain = (Resolve-Path cmake\mipsel-none-elf.cmake).Path
cmake -S . -B build -G Ninja "-DCMAKE_TOOLCHAIN_FILE=$toolchain" -DCMAKE_BUILD_TYPE=Release
cmake --build build
```

生成物は `dumper/build/ps1biosqr.exe` です。CDイメージ化はまだ独立した工程です。
Sonyのライセンスセクターはこのプロジェクトでは配布しません。

現在はNTSC 320×240を対象にしています。`mipsel-none-elf-gcc 12.3.0` でのビルドは
確認済みです。RetroArchのPCSX-ReARMedでは映像出力からBIOS全体を復元できました。
次画面のPIO転送中も現在画面が表示されることを保持時間として利用し、PCSX-ReARMedの
ヘッドレス録画では2分19秒で512 KiBの復元が完了します。
Beetle PSXでは現在の直接GPU制御による画面が表示されなかったため、エミュレータ検証には
PCSX-ReARMedを使用してください。実機検証前のためGPUタイミングや起動方法は今後調整される
可能性があります。
