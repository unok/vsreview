export const COMMAND_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
export function commandEnvironment(): NodeJS.ProcessEnv {
  // -C の対象やオブジェクト・設定を差し替える変数は、許可ルート外への操作や設定注入を防ぐため除く。
  // CEILING_DIRECTORIES と CONFIG_NOSYSTEM/GLOBAL/SYSTEM など、利用者が探索・設定読込を制限する変数は保持する。
  const overrides =
    /^(?:GIT_(?:DIR|WORK_TREE|INDEX_FILE|SHALLOW_FILE|ATTR_SOURCE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT)|GIT_CONFIG_(?:KEY|VALUE)_.*)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !overrides.test(key)));
  return { ...env, LC_ALL: 'C', LANGUAGE: 'C' };
}
