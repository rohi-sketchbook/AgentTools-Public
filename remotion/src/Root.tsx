import React from 'react';
import {Composition} from 'remotion';
import {HelloDevSpace} from './HelloDevSpace';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="HelloDevSpace"
        component={HelloDevSpace}
        durationInFrames={150}
        fps={30}
        width={1280}
        height={720}
      />
    </>
  );
};
