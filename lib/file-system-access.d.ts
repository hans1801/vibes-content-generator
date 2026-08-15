// lib.dom.d.ts doesn't declare FileSystemDirectoryHandle.entries() yet, even
// though Chrome implements it (File System Access API spec). Augment the
// global type here instead of casting through `unknown` at every call site.
export {};

declare global {
  interface FileSystemDirectoryHandle {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  }
}
