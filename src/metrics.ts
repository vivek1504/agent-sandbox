import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from "prom-client";

export const register = new Registry();

collectDefaultMetrics({ register });

export const httpRequestDuration = new Histogram({
  name: "http_request_duration",
  help: "Duration of HTTP requests",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const httpRequestsTotal = new Counter({
  name: "total_http_requests",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});

export const vmCount = new Gauge({
  name: "active_vm_count",
  help: "Number of currently active VMs",
  labelNames: ["function_id", "state"],
  registers: [register],
});

export const vmCreationTime = new Histogram({
  name: "vm_creation_time",
  help: "Time to create and restore a VM from snapshot",
  buckets: [0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

export const vmCreationTotal = new Counter({
  name: "total_vm_created",
  help: "Total VMs created",
  labelNames: ["status"],
  registers: [register],
});

export const vmCleanupTotal = new Counter({
  name: "total_vm_cleanups",
  help: "Total VMs cleaned up",
  registers: [register],
});

export const vsockConnectionTime = new Histogram({
  name: "vsock_connection_time",
  help: "Time to establish vsock connection",
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [register],
});

export const vsockErrors = new Counter({
  name: "vsock_errors_total",
  help: "Total vsock connection/read errors",
  labelNames: ["error_type"],
  registers: [register],
});

export const execSessionsActive = new Gauge({
  name: "exec_sessions_active",
  help: "Active sessions",
  registers: [register],
});

export const execSessionDurationSeconds = new Histogram({
  name: "exec_session_duration_seconds",
  help: "Session lifetime",
  buckets: [1, 5, 30, 60, 300, 900, 1800, 3600],
  registers: [register],
});

export const execMessageTotal = new Counter({
  name: "exec_message_total",
  help: "Messages by type + status",
  labelNames: ["type", "status"],
  registers: [register],
});

export const execMessageDurationSeconds = new Histogram({
  name: "exec_message_duration_seconds",
  help: "Message round-trip time",
  labelNames: ["type"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60],
  registers: [register],
});

export const execProcessExitCode = new Counter({
  name: "exec_process_exit_code",
  help: "Exit codes by command",
  labelNames: ["command", "exit_code"],
  registers: [register],
});

export const execWorkspaceBytesWritten = new Counter({
  name: "exec_workspace_bytes_written",
  help: "Bytes written to workspaces",
  registers: [register],
});

export const vmResourceConfig = new Gauge({
  name: "vm_resource_config",
  help: "Configured resource limits per VM",
  labelNames: ["resource"],
  registers: [register],
});

export const vmEgressPolicyApplied = new Counter({
  name: "vm_egress_policy_applied_total",
  help: "Count of egress policies applied to VMs",
  labelNames: ["dns_mode", "dest_mode", "bw_enabled"],
  registers: [register],
});

export const vmTemplateUsage = new Counter({
  name: "vm_template_usage_total",
  help: "VMs created by template name",
  labelNames: ["template"],
  registers: [register],
});


