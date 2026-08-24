# Dumper

PS1本体の512 KiB BIOSを読み、独自の8色2次元コードとして画面へ繰り返し表示します。

PSn00bSDK、Psy-QなどのSDKは使用しません。GPUレジスタ操作、起動コード、PS-X EXE生成を
このディレクトリ内で実装しています。ビルドツールとして以下は必要です。

- CMake 3.21以降
- Ninja
- `mipsel-none-elf-gcc` ツールチェーン
- Python 3.10以降（ELFからPS-X EXEへの変換には標準ライブラリだけを使用）

```sh
cmake -S dumper -B dumper/build -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE=dumper/cmake/mipsel-none-elf.cmake
cmake --build dumper/build
```

生成物は `dumper/build/ps1biosqr.exe` です。CDイメージ化はまだ独立した工程です。
Sonyのライセンスセクターはこのプロジェクトでは配布しません。

現在はNTSC 320×240を対象にしています。実機検証前のため、GPUタイミングや起動方法は
今後調整される可能性があります。
