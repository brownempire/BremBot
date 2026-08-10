export type FloatingPanelPosition = {
  left: number;
  top: number;
};

export function clampFloatingPanelPosition(input: {
  left: number;
  top: number;
  panelWidth: number;
  panelHeight: number;
  containerWidth: number;
  containerHeight: number;
  margin?: number;
}): FloatingPanelPosition {
  const margin = Math.max(0, input.margin ?? 4);
  const maximumLeft = Math.max(margin, input.containerWidth - input.panelWidth - margin);
  const maximumTop = Math.max(margin, input.containerHeight - input.panelHeight - margin);

  return {
    left: Math.min(Math.max(input.left, margin), maximumLeft),
    top: Math.min(Math.max(input.top, margin), maximumTop),
  };
}
