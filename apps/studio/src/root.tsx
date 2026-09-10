import React from "react";
import { Composition } from "remotion";
import { DemoMotion } from "./video/DemoMotion.js";
import { DemoProjectSchema } from "@demomotion/schema";

const defaultProps = {
  version: 1 as const,
  title: "DemoMotion",
  sourceVideo: "",
  width: 1920,
  height: 1080,
  fps: 30,
  durationMs: 5000,
  style: {
    background: "#0b1020", padding: 56, radius: 24, shadow: true,
    captionColor: "#c8d2e6", captionActiveColor: "#ffffff", captionAccent: "#38bdf8",
    captionEmphasis: 0.06, captionScale: 1,
    cutTransitionMs: 180, openingFadeMs: 320, endingFadeMs: 420
  },
  actions: [],
  zooms: [],
  // Identity edit: the whole capture, normal speed (spec section 3).
  editList: [{ sourceFromMs: 0, sourceToMs: 5000, speed: 1 }],
  callouts: [],
  // No captions by default. An absent caption list is a legitimate "no
  // captions", so this is an empty track, not a missing one.
  captions: []
};

export const Root: React.FC = () => (
  <Composition
    id="DemoMotion"
    component={DemoMotion}
    schema={DemoProjectSchema}
    defaultProps={defaultProps}
    durationInFrames={150}
    fps={30}
    width={1920}
    height={1080}
    calculateMetadata={({ props }) => ({
      durationInFrames: Math.max(1, Math.ceil((props.durationMs / 1000) * props.fps)),
      fps: props.fps,
      width: props.width,
      height: props.height
    })}
  />
);
