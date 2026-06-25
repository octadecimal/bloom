/** Returns an enqueue() that runs tasks strictly in call order, each awaiting
 *  the previous, isolating failures so one rejected task cannot wedge the chain. */
export function createSerializer(): (task: () => unknown | Promise<unknown>) => void {
  let chain: Promise<unknown> = Promise.resolve();
  return (task) => {
    chain = chain.then(task).catch(() => {});
  };
}
