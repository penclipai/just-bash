import { shareFileSystemIdentity } from "../fs/identity.js";
import { InMemoryFs } from "../fs/in-memory-fs/index.js";
import type { CpOptions, IFileSystem } from "../fs/interface.js";
import {
  registerOutputFileAppender,
  registerOutputFileWriter,
  tryAppendOutputFile,
  writeOutputFile,
} from "../fs/output-write.js";
import { dirname, MAX_SYMLINK_DEPTH } from "../fs/path-utils.js";
import { _Proxy } from "../security/trusted-globals.js";
import { bufferByteReader } from "../utils/buffer-byte-reader.js";
import { getErrorCode } from "./helpers/errors.js";
import type { InterpreterState } from "./types.js";
import { bindShellFileSystem, rebindShellFileSystem } from "./umask-fs.js";

const DIRECTORY = "/dev/fd";
interface NamespaceData {
  scratch: InMemoryFs;
  isolated: boolean;
  inherited: Set<object>;
  aliases: Map<string, { target: string; resolved: string }>;
  started: boolean;
}
const namespaces = new WeakMap<IFileSystem, NamespaceData>();
const reboundParents = new WeakMap<InterpreterState, NamespaceData>();
const singlePaths = new Set([
  "readFile",
  "readFileBytes",
  "readFileBuffer",
  "openByteReader",
  "writeFile",
  "appendFile",
  "exists",
  "stat",
  "lstat",
  "readlink",
  "rm",
  "chmod",
  "utimes",
  "createExclusive",
]);
const noFollow = new Set(["lstat", "readlink", "rm", "createExclusive"]);
const readablePaths = new Set([
  "readFile",
  "readFileBytes",
  "readFileBuffer",
  "openByteReader",
  "stat",
  "lstat",
  "readlink",
]);
const mutatingPaths = new Set([
  "writeFile",
  "appendFile",
  "rm",
  "chmod",
  "utimes",
  "createExclusive",
]);

/** Child descriptors are private; the root retains its backend's capabilities. */
export function createProcessFdNamespace(
  parent: IFileSystem,
  state: InterpreterState,
): IFileSystem {
  const inherited = namespaces.get(parent) ?? reboundParents.get(state);
  const data: NamespaceData = {
    scratch: new InMemoryFs(),
    isolated: Boolean(inherited),
    inherited: new Set(state.processSubstitutions),
    aliases: inherited?.aliases ?? new Map(),
    started: false,
  };
  data.scratch.mkdirSync(DIRECTORY, { recursive: true });
  return bindNamespace(parent, state, data);
}

function bindNamespace(
  parent: IFileSystem,
  state: InterpreterState,
  data: NamespaceData,
): IFileSystem {
  const normalize = (path: string) => parent.resolvePath("/", path);
  const owned = (path: string) =>
    state.processSubstitutions?.some(
      (entry) => entry.path === path && !data.inherited.has(entry),
    ) ?? false;
  const select = (path: string) =>
    data.isolated && owned(path) ? data.scratch : parent;
  const hasPrivateDescriptors = () =>
    data.isolated &&
    state.processSubstitutions?.some((entry) => !data.inherited.has(entry));
  const route = async (value: string, follow: boolean, discover = false) => {
    let path = normalize(value);
    for (let depth = 0; depth < MAX_SYMLINK_DEPTH; depth++) {
      let replaced = false;
      for (const [alias, target] of data.aliases) {
        if (path === alias ? !follow : !path.startsWith(`${alias}/`)) continue;
        if (
          (await parent.readlink(alias).catch(() => undefined)) !==
          target.target
        ) {
          data.aliases.delete(alias);
          continue;
        }
        path = normalize(target.resolved + path.slice(alias.length));
        replaced = true;
        break;
      }
      if (replaced) continue;
      const fs = select(path);
      if (fs === parent && discover) {
        const parts = path.split("/");
        for (let end = parts.length - Number(!follow); end > 1; end--) {
          const alias = parts.slice(0, end).join("/");
          const target = await parent.readlink(alias).catch(() => undefined);
          if (target === undefined) continue;
          data.aliases.set(alias, {
            target,
            resolved: parent.resolvePath(dirname(alias), target),
          });
          replaced = true;
          break;
        }
        if (replaced) continue;
      }
      if (fs === data.scratch && follow) {
        const stat = await fs.lstat(path).catch((error) => {
          if (getErrorCode(error) === "ENOENT") return undefined;
          throw error;
        });
        if (stat?.isSymbolicLink) {
          path = parent.resolvePath(dirname(path), await fs.readlink(path));
          continue;
        }
      }
      return { fs, path };
    }
    throw new Error(`ELOOP: too many symbolic links, '${value}'`);
  };
  const mutationTarget = async (path: string, follow: boolean) => {
    const selected = await route(path, follow);
    if (selected.fs !== parent || !hasPrivateDescriptors()) return selected;
    try {
      await (follow ? parent.stat(selected.path) : parent.lstat(selected.path));
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") throw error;
      return route(path, follow, true);
    }
    return selected;
  };
  const directoryUsed = () =>
    data.isolated &&
    (data.started ||
      Boolean(
        state.processSubstitutions?.some((entry) => !data.inherited.has(entry)),
      ));
  const readdir = async (path: string) => {
    if (normalize(path) !== DIRECTORY || !directoryUsed())
      return parent.readdir(path);
    const names = await parent.readdir(path).catch((error): string[] => {
      if (getErrorCode(error) === "ENOENT") return [];
      throw error;
    });
    for (const name of await data.scratch.readdir(DIRECTORY))
      if (owned(`${DIRECTORY}/${name}`)) names.push(name);
    return [...new Set(names)].sort();
  };
  let facade: IFileSystem;
  const copy = async (src: string, dest: string, options?: CpOptions) => {
    const source = await route(src, false),
      destination = await route(dest, false);
    if (source.fs === destination.fs)
      return source.fs.cp(source.path, destination.path, options);
    const stat = await source.fs.lstat(source.path);
    if (stat.isFile) {
      const bytes = await source.fs.readFileBuffer(source.path);
      await destination.fs.writeFile(destination.path, bytes);
      await destination.fs.chmod(destination.path, stat.mode);
    } else if (stat.isSymbolicLink)
      await facade.symlink(await source.fs.readlink(source.path), dest);
    else
      throw new Error(
        `ENOTDIR: process descriptor is not a directory, '${src}'`,
      );
  };
  const methods = {
    readdir,
    async readdirWithFileTypes(path: string) {
      if (normalize(path) !== DIRECTORY || !directoryUsed())
        return parent.readdirWithFileTypes?.(path);
      return Promise.all(
        (await readdir(path)).map(async (name) => ({
          name,
          ...(await facade.lstat(`${DIRECTORY}/${name}`)),
        })),
      );
    },
    getAllPaths() {
      return [
        ...new Set([
          ...parent.getAllPaths(),
          ...(data.started
            ? data.scratch
                .getAllPaths()
                .filter(
                  (path) =>
                    path === DIRECTORY || path === "/dev" || owned(path),
                )
            : []),
        ]),
      ];
    },
    async mkdir(path: string, options?: { recursive?: boolean }) {
      if (data.isolated && owned(normalize(path)))
        throw new Error(`EEXIST: process descriptor exists, mkdir '${path}'`);
      return parent.mkdir(path, options);
    },
    cp: copy,
    async mv(src: string, dest: string) {
      const source = await route(src, false),
        destination = await route(dest, false);
      if (source.fs === destination.fs)
        return source.fs.mv(source.path, destination.path);
      await copy(src, dest);
      await source.fs.rm(source.path);
    },
    async link(src: string, dest: string) {
      const source = await route(src, false),
        destination = await route(dest, false);
      if (source.fs === destination.fs)
        return source.fs.link(source.path, destination.path);
      throw new Error(
        `EXDEV: cross-device link not permitted, link '${src}' -> '${dest}'`,
      );
    },
    async symlink(target: string, linkPath: string) {
      const destination = await route(linkPath, false);
      await destination.fs.symlink(target, destination.path);
      const resolved = parent.resolvePath(dirname(normalize(linkPath)), target);
      if (
        destination.fs === parent &&
        (resolved === DIRECTORY || resolved.startsWith(`${DIRECTORY}/`))
      )
        data.aliases.set(normalize(linkPath), { target, resolved });
    },
    async realpath(path: string) {
      const target = await route(path, true);
      return target.fs.realpath(target.path);
    },
  };
  facade = new _Proxy(parent, {
    get(target, key) {
      if (key === "constructor" || key === "prototype" || key === "__proto__")
        throw new Error("Unsafe process namespace filesystem property");
      // @banned-pattern-ignore: gadget keys are rejected above; target is the fixed host filesystem capability.
      const operation = Reflect.get(target, key, target);
      if (typeof operation !== "function") return operation;
      if (Object.hasOwn(methods, key))
        // @banned-pattern-ignore: own fixed method names are admitted above.
        return Reflect.get(methods, key, methods);
      if (singlePaths.has(String(key)))
        return async (path: string, ...args: unknown[]) => {
          if (
            (key === "stat" || key === "lstat" || key === "exists") &&
            normalize(path) === DIRECTORY &&
            directoryUsed()
          )
            return key === "exists" ? true : data.scratch.stat(DIRECTORY);
          const perform = async (discover = false) => {
            const follow = !noFollow.has(String(key));
            const selected = mutatingPaths.has(String(key))
              ? await mutationTarget(path, follow)
              : await route(path, follow, discover);
            if (selected.fs === data.scratch) {
              if (key === "writeFile" || key === "appendFile")
                data.started = true;
              if (key === "openByteReader")
                return bufferByteReader(
                  await data.scratch.readFileBuffer(selected.path),
                );
            }
            // @banned-pattern-ignore: key is restricted to the fixed singlePaths filesystem method allowlist.
            const method = Reflect.get(selected.fs, key, selected.fs) as (
              ...input: unknown[]
            ) => unknown;
            return method.call(selected.fs, selected.path, ...args);
          };
          try {
            return await perform();
          } catch (error) {
            if (
              getErrorCode(error) !== "ENOENT" ||
              !readablePaths.has(String(key)) ||
              !hasPrivateDescriptors()
            )
              throw error;
            return perform(true);
          }
        };
      return operation.bind(target);
    },
  });
  shareFileSystemIdentity(facade, parent);
  namespaces.set(facade, data);
  registerOutputFileWriter(
    facade,
    async (key, path, content, options, provenance) => {
      const selected = await mutationTarget(path, true);
      if (selected.fs === data.scratch) data.started = true;
      return writeOutputFile(
        selected.fs,
        key,
        selected.path,
        content,
        options,
        provenance,
      );
    },
  );
  registerOutputFileAppender(facade, async (path, size, content, options) => {
    const selected = await mutationTarget(path, true);
    return selected.fs === data.scratch
      ? false
      : tryAppendOutputFile(parent, selected.path, size, content, options);
  });
  return bindShellFileSystem(facade, (next) => {
    const rebound = bindNamespace(
      rebindShellFileSystem(parent, next),
      next,
      data,
    );
    reboundParents.set(next, data);
    return rebound;
  });
}
