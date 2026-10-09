declare module 'proper-lockfile' {
  const lockfile: {
    lock(
      path: string,
      options?: { retries?: number; stale?: number; update?: number },
    ): Promise<() => Promise<void>>;
  };
  export default lockfile;
}
