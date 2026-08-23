/**
 * Deployment-owned configuration.
 *
 * A clean clone deliberately inherits no proxy, account, or hosted endpoint.
 * Direct browser providers and local calculations still work. Set workerUrl to
 * a Worker you control to enable aircraft and nearby-radio discovery.
 */
export default Object.freeze({
  workerUrl: '',
});
