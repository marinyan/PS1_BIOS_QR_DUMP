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

## BIN/CUEの生成

任意のホストツールとして
[`mkpsxiso` 2.30以降](https://github.com/Lameguy64/mkpsxiso/releases)
を用意すると、ライセンスセクターを含まないBIN/CUEを生成できます。CMakeの構成時に
実行ファイルを指定し、専用ターゲットをビルドします。

```powershell
$mkpsxiso = (Resolve-Path C:\mkpsxiso\mkpsxiso.exe).Path
cmake -S . -B build -G Ninja "-DCMAKE_TOOLCHAIN_FILE=$toolchain" `
  "-DMKPSXISO_EXECUTABLE=$mkpsxiso" -DCMAKE_BUILD_TYPE=Release
cmake --build build --target ps1biosqr_disc
```

生成物は `dumper/build/ps1biosqr.bin` と `ps1biosqr.cue` です。PCSX-ReARMedでは
CUEから起動し、表示コードの内容が実行対象BIOSと一致するところまで確認しています。

このイメージにSonyの認証データはありません。そのまま起動できるのはエミュレータ、
modchip、swap方式、homebrewランチャーなどを利用できる環境です。無改造PS1のCD認証を
通るイメージではありません。

現在はNTSC 320×240を対象にしています。`mipsel-none-elf-gcc 12.3.0` でのビルドは
確認済みです。RetroArchのPCSX-ReARMedでは映像出力からBIOS全体を復元できました。
次画面のPIO転送中も現在画面が表示されることを保持時間として利用し、PCSX-ReARMedの
ヘッドレス録画では2分19秒で512 KiBの復元が完了します。生成したBIN/CUEからの起動も
PCSX-ReARMedで確認済みです。
Beetle PSXでは現在の直接GPU制御による画面が表示されなかったため、エミュレータ検証には
PCSX-ReARMedを使用してください。実機検証前のためGPUタイミングや起動方法は今後調整される
可能性があります。
