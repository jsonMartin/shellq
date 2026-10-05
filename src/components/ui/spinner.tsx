import cliSpinners from "cli-spinners";
import type { SpinnerName } from "cli-spinners";
import type { BoxProps } from "@opentui/react";

import { useMotion, useTheme } from "@/components/ui/theme-provider";
import { useAnimation } from "@/hooks/use-animation";

export type SpinnerType = SpinnerName;

export const spinnerNames = Object.keys(cliSpinners) as SpinnerName[];

export interface SpinnerProps extends Omit<BoxProps, "children"> {
  type?: SpinnerType;
  label?: string;
  color?: string;
  fps?: number;
  frames?: string[];
}

export const Spinner = ({
  type = "dots",
  label,
  color,
  fps = 12,
  frames: customFrames,
  ...props
}: SpinnerProps) => {
  const theme = useTheme();
  const motion = useMotion();
  const builtin = cliSpinners[type] ?? cliSpinners.dots;
  const useCustomFrames = Boolean(customFrames?.length);
  const frames = useCustomFrames ? customFrames! : builtin.frames;
  const frame = useAnimation(
    useCustomFrames ? fps : { intervalMs: builtin.interval },
    !motion.reduced
  );
  const icon = frames[frame % frames.length];
  const resolvedColor = color ?? theme.colors.primary;

  return (
    <box alignItems="center" flexDirection="row" {...props}>
      <text fg={resolvedColor}>{icon}</text>
      {label ? <text marginLeft={1}>{label}</text> : null}
    </box>
  );
};
