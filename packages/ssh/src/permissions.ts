import type { PermissionLevel } from '@opsense/schema';

import type { CommandExecutionResult, SafeCommandExecutor } from './executor.js';

export interface PermissionProbe {
  groups: string[];
  level: PermissionLevel;
  results: CommandExecutionResult[];
  sudoNonInteractive: boolean;
  uid?: number;
  user?: string;
}

export async function detectPermissions(
  executor: SafeCommandExecutor,
  options: { signal?: AbortSignal } = {},
): Promise<PermissionProbe> {
  const executionOptions = options.signal === undefined ? {} : { signal: options.signal };
  const [uidResult, userResult, groupsResult, sudoResult] = await Promise.all([
    executor.executeById('permission.uid', {}, executionOptions),
    executor.executeById('permission.user', {}, executionOptions),
    executor.executeById('permission.groups', {}, executionOptions),
    executor.executeById('permission.sudo', {}, executionOptions),
  ]);

  const uid = parseUid(uidResult);
  const user = parseText(userResult);
  const groups = parseText(groupsResult)?.split(/\s+/).filter(Boolean) ?? [];
  const sudoNonInteractive = sudoResult.status === 'success';
  const level = derivePermissionLevel({
    permissionDenied: [uidResult, userResult, groupsResult].some(
      (result) => result.status === 'permission_denied',
    ),
    sudoNonInteractive,
    ...(uid === undefined ? {} : { uid }),
  });

  return {
    groups,
    level,
    results: [uidResult, userResult, groupsResult, sudoResult],
    sudoNonInteractive,
    ...(uid === undefined ? {} : { uid }),
    ...(user === undefined ? {} : { user }),
  };
}

export function derivePermissionLevel(options: {
  permissionDenied: boolean;
  sudoNonInteractive: boolean;
  uid?: number;
}): PermissionLevel {
  if (options.uid === 0 || options.sudoNonInteractive) {
    return 'privileged';
  }
  if (options.permissionDenied) {
    return 'partial_privileged';
  }
  return 'unprivileged';
}

function parseUid(result: CommandExecutionResult): number | undefined {
  const parsed = Number.parseInt(result.stdout.trim(), 10);
  return result.status === 'success' && Number.isInteger(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

function parseText(result: CommandExecutionResult): string | undefined {
  const value = result.stdout.trim();
  return result.status === 'success' && value.length > 0 ? value : undefined;
}
