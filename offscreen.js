// 离屏文档：注册成功时播放一段悦耳的和弦提示音（Web Audio 合成，无需音频文件）

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "play_success") {
    playChime();
  }
});

function playChime() {
  try {
    const ctx = new AudioContext();
    // C5 -> E5 -> G5 大三和弦上行，轻快
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.35, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
      osc.start(t);
      osc.stop(t + 0.65);
    });
    // 播完自动关闭离屏文档，避免一直占用
    setTimeout(() => ctx.close(), 1200);
  } catch (e) {
    // 忽略播放失败
  }
}
