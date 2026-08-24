(function () {
  "use strict";

  const videoFile = document.getElementById("videoFile");
  const video = document.getElementById("video");
  const canvas = document.getElementById("preview");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const speed = document.getElementById("speed");
  const seek = document.getElementById("seek");
  const time = document.getElementById("time");
  const markCorners = document.getElementById("markCorners");
  const fullFrame = document.getElementById("fullFrame");
  const start = document.getElementById("start");
  const stop = document.getElementById("stop");
  const instruction = document.getElementById("instruction");
  const progress = document.getElementById("progress");
  const status = document.getElementById("status");
  const details = document.getElementById("details");
  const download = document.getElementById("download");

  let sourceUrl = null;
  let downloadUrl = null;
  let corners = [];
  let choosingCorners = false;
  let decoding = false;
  let runToken = 0;
  let collector = null;
  let rejected = 0;
  let sampled = 0;

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return "0:00";
    const whole = Math.max(0, Math.floor(seconds));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  }

  function updateTime() {
    seek.value = String(video.currentTime || 0);
    time.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
  }

  function drawOverlay() {
    if (!corners.length) return;
    context.save();
    context.lineWidth = Math.max(2, canvas.width / 400);
    context.strokeStyle = "#ff4d8d";
    context.fillStyle = "#ff4d8d";
    context.font = `${Math.max(16, canvas.width / 40)}px system-ui`;
    context.beginPath();
    corners.forEach(([x, y], index) => {
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      context.beginPath();
      context.arc(x, y, 6, 0, Math.PI * 2);
      context.fill();
      context.fillText(String(index + 1), x + 10, y - 10);
    });
    if (corners.length === 4) {
      context.beginPath();
      context.moveTo(corners[0][0], corners[0][1]);
      corners.slice(1).forEach(([x, y]) => context.lineTo(x, y));
      context.closePath();
      context.stroke();
    }
    context.restore();
  }

  function drawVideo() {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    drawOverlay();
    return imageData;
  }

  function setReady(enabled) {
    markCorners.disabled = !enabled || decoding;
    fullFrame.disabled = !enabled || decoding;
    start.disabled = !enabled || decoding || corners.length !== 4;
    seek.disabled = !enabled || decoding;
    stop.disabled = !decoding;
  }

  function resetDownload() {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
    download.hidden = true;
  }

  videoFile.addEventListener("change", () => {
    const file = videoFile.files && videoFile.files[0];
    if (!file) return;
    runToken += 1;
    decoding = false;
    video.pause();
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    sourceUrl = URL.createObjectURL(file);
    video.src = sourceUrl;
    corners = [];
    resetDownload();
    status.textContent = "動画を読み込んでいます";
    details.textContent = "";
  });

  video.addEventListener("loadedmetadata", () => {
    const width = Math.min(960, video.videoWidth);
    canvas.width = width;
    canvas.height = Math.round(width * video.videoHeight / video.videoWidth);
    seek.max = String(video.duration);
    video.currentTime = 0;
    corners = [[0, 0], [canvas.width - 1, 0], [canvas.width - 1, canvas.height - 1], [0, canvas.height - 1]];
    instruction.textContent = "コード画面へ移動し、必要なら四隅を指定してください。";
    status.textContent = "準備完了";
    updateTime();
    setReady(true);
  });

  video.addEventListener("seeked", () => {
    if (!decoding) drawVideo();
    updateTime();
  });

  video.addEventListener("ended", () => {
    if (decoding) finish(collector.complete);
  });

  seek.addEventListener("input", () => {
    video.currentTime = Number(seek.value);
  });

  markCorners.addEventListener("click", () => {
    choosingCorners = true;
    corners = [];
    instruction.textContent = "左上 → 右上 → 右下 → 左下の順にクリックしてください。";
    drawVideo();
    setReady(true);
  });

  fullFrame.addEventListener("click", () => {
    choosingCorners = false;
    corners = [[0, 0], [canvas.width - 1, 0], [canvas.width - 1, canvas.height - 1], [0, canvas.height - 1]];
    instruction.textContent = "動画全体をコード領域として使用します。";
    drawVideo();
    setReady(true);
  });

  canvas.addEventListener("click", (event) => {
    if (!choosingCorners || decoding) return;
    const rectangle = canvas.getBoundingClientRect();
    const point = [
      (event.clientX - rectangle.left) * canvas.width / rectangle.width,
      (event.clientY - rectangle.top) * canvas.height / rectangle.height,
    ];
    corners.push(point);
    if (corners.length === 4) {
      choosingCorners = false;
      instruction.textContent = "四隅を設定しました。解析を開始できます。";
    }
    drawVideo();
    setReady(true);
  });

  function updateProgress() {
    progress.max = collector.expected || 1;
    progress.value = collector.received;
    status.textContent = collector.expected
      ? `${collector.received} / ${collector.expected} チャンク回収`
      : "有効なコードを探索中";
    details.textContent = `${sampled}フレーム解析、${rejected}フレーム棄却、動画 ${formatTime(video.currentTime)}`;
  }

  function finish(success) {
    decoding = false;
    runToken += 1;
    video.pause();
    setReady(true);
    updateTime();
    if (!success) {
      instruction.textContent = "動画の終端まで解析しました。別の周回を含む動画でもう一度試せます。";
      status.textContent = `未完了: ${collector.received} / ${collector.expected || 0}`;
      const missing = collector.missing();
      details.textContent = `不足チャンク: ${missing.join(", ")}${collector.expected > missing.length ? " …" : ""}`;
      return;
    }
    try {
      const bios = collector.assemble();
      downloadUrl = URL.createObjectURL(new Blob([bios], { type: "application/octet-stream" }));
      download.href = downloadUrl;
      download.hidden = false;
      instruction.textContent = "解析が完了しました。復元したBIOSを保存できます。";
      status.textContent = `復元成功: ${bios.length} bytes`;
      details.textContent = `全体CRC32検証済み。${sampled}フレーム解析、${rejected}フレーム棄却。`;
    } catch (error) {
      instruction.textContent = "全チャンクは揃いましたが、最終検証に失敗しました。";
      status.textContent = `復元失敗: ${error.message}`;
    }
  }

  function schedule(token) {
    if (!decoding || token !== runToken) return;
    const callback = () => {
      if (!decoding || token !== runToken) return;
      const imageData = drawVideo();
      sampled += 1;
      try {
        const scan = PVQR.sampleMatrix(imageData, corners);
        const packet = PVQR.parsePacket(PVQR.matrixToPacket(scan.matrix));
        collector.add(packet);
      } catch (error) {
        if (!(error instanceof PVQR.ProtocolError)) throw error;
        rejected += 1;
      }
      updateProgress();
      if (collector.complete) {
        finish(true);
      } else if (video.ended) {
        finish(false);
      } else {
        schedule(token);
      }
    };
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(callback);
    } else {
      requestAnimationFrame(callback);
    }
  }

  start.addEventListener("click", async () => {
    if (corners.length !== 4) return;
    resetDownload();
    collector = new PVQR.TransferCollector();
    rejected = 0;
    sampled = 0;
    decoding = true;
    runToken += 1;
    const token = runToken;
    video.playbackRate = Number(speed.value);
    setReady(true);
    instruction.textContent = "解析中です。ブラウザを前面に置いたままにしてください。";
    try {
      await video.play();
      schedule(token);
    } catch (error) {
      decoding = false;
      status.textContent = `動画を再生できません: ${error.message}`;
      setReady(true);
    }
  });

  stop.addEventListener("click", () => finish(false));
})();
