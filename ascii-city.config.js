/**
 * Deployment-owned configuration.
 *
 * The official GitHub Pages hostname opts into its deployment-owned Worker.
 * Every clone and alternate hostname still defaults to no inherited service;
 * replace the expression with your own Worker URL when deploying a fork.
 */
export const workerUrlForHost = (hostname) => hostname === 'tweakyourpc.github.io'
  ? 'https://ascii-city-2.ascii-city-v2.workers.dev'
  : '';

export default Object.freeze({
  workerUrl: workerUrlForHost(globalThis.location?.hostname),
});
