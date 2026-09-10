import React from "react";
import {
  AbsoluteFill,
  OffthreadVideo,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig
} from "remotion";
import type { DemoProject } from "@demomotion/schema";

function activeZoom(project: DemoProject, nowMs: number) {
  return project.zooms.find((z) => nowMs >= z.fromMs && nowMs <= z.toMs);
}

export const DemoMotion: React.FC<DemoProject> = (project) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const nowMs = frame / fps * 1000;
  const zoom = activeZoom(project, nowMs);
  const callout = project.callouts.find((c) => nowMs >= c.fromMs && nowMs <= c.toMs);

  let scale = 1;
  let originX = 0.5;
  let originY = 0.5;

  if (zoom) {
    const local = nowMs - zoom.fromMs;
    const duration = zoom.toMs - zoom.fromMs;
    const inMs = Math.min(250, duration * 0.3);
    const outMs = Math.min(300, duration * 0.3);
    const rampIn = interpolate(local, [0, inMs], [1, zoom.scale], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    const rampOut = interpolate(local, [duration - outMs, duration], [zoom.scale, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    scale = Math.min(rampIn, rampOut);
    originX = zoom.x;
    originY = zoom.y;
  }

  const pad = project.style.padding;
  const contentW = width - pad * 2;
  const contentH = height - pad * 2;

  return (
    <AbsoluteFill style={{ background: project.style.background, alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
      <div style={{
        width: contentW,
        height: contentH,
        overflow: "hidden",
        borderRadius: project.style.radius,
        boxShadow: project.style.shadow ? "0 30px 80px rgba(0,0,0,0.45)" : undefined,
        background: "#000",
        position: "relative"
      }}>
        <div style={{
          width: "100%", height: "100%",
          transform: `scale(${scale})`,
          transformOrigin: `${originX * 100}% ${originY * 100}%`,
          willChange: "transform"
        }}>
          <OffthreadVideo src={staticFile(project.sourceVideo)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </div>
      </div>
      {callout ? (
        <div style={{
          position: "absolute",
          left: `${callout.x * 100}%`,
          top: `${callout.y * 100}%`,
          transform: "translate(-50%, -50%)",
          maxWidth: width * 0.7,
          padding: "16px 24px",
          borderRadius: 18,
          background: "rgba(8,12,24,.88)",
          color: "white",
          fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
          fontSize: Math.max(22, width * 0.018),
          fontWeight: 650,
          lineHeight: 1.2,
          boxShadow: "0 16px 50px rgba(0,0,0,.32)"
        }}>{callout.text}</div>
      ) : null}
    </AbsoluteFill>
  );
};
