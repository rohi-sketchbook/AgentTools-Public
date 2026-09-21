import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

export const HelloDevSpace: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const scale = spring({
    frame,
    fps,
    config: {damping: 14, stiffness: 120},
  });

  const opacity = interpolate(frame, [0, 20, 120, 149], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #0c1118 0%, #15242b 100%)',
        color: 'white',
        fontFamily: 'Arial, sans-serif',
      }}
    >
      <div
        style={{
          opacity,
          transform: `scale(${scale})`,
          textAlign: 'center',
        }}
      >
        <div style={{fontSize: 78, fontWeight: 800}}>Remotion</div>
        <div style={{fontSize: 34, marginTop: 18, opacity: 0.85}}>
          DevSpace video pipeline is ready
        </div>
      </div>
    </AbsoluteFill>
  );
};
