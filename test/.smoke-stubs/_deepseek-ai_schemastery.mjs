const fn = () => proxy
const proxy = new Proxy(fn, { get: () => fn, apply: () => proxy })
export default proxy
export const object = proxy
