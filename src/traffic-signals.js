/** Coordinated two-direction signal timing: 12s green, 3s amber, 1s all-red. */
export const SIGNAL_CYCLE_SECONDS = 32;

export function signalState(seconds, group = 0, offset = 0) {
  const shifted = seconds + offset + (group ? 16 : 0);
  const phase = ((shifted % SIGNAL_CYCLE_SECONDS) + SIGNAL_CYCLE_SECONDS) % SIGNAL_CYCLE_SECONDS;
  if (phase < 12) return 'green';
  if (phase < 15) return 'amber';
  return 'red';
}

export function signalGroupForIncoming(graph, node, edge) {
  const junction = graph.signalJunctions.find((j) => j.id === node.id);
  if (!junction) return 0;
  const approach = junction.approaches.find((a) => a.nodeId === edge.from);
  return approach?.group ?? 0;
}
