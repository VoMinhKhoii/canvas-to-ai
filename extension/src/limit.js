// limiter(n) → limit(task): runs task() once fewer than n tasks are running;
// tasks start in the order they were given.
export function limiter(n) {
  let active = 0;
  let queue = [];
  let head = 0; // next task to start: shift() would copy the queue each time
  const pump = () => {
    while (active < n && head < queue.length) {
      const { task, resolve, reject } = queue[head];
      queue[head++] = null;
      if (head === queue.length) (queue = []), (head = 0);
      active++;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  };
  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}
