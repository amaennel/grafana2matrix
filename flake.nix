{
  description = "Grafana to Matrix webhook adapter - A bridge between Grafana Alerting and Matrix";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        grafana2matrix = pkgs.buildNpmPackage {
          pname = "grafana2matrix";
          version = "0.1.7";

          src = ./.;

          npmDepsHash = "sha256-yUDZJSufT7ZgJS0YwJroPutV238ppfvGBQhPQ1fzwOo=";

          nativeBuildInputs = [ pkgs.makeBinaryWrapper ];

          buildPhase = ''
            runHook preBuild
            # Nothing to do here
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            mkdir -p $out/lib/grafana2matrix
            cp -r . $out/lib/grafana2matrix/

            # Create wrapper script
            mkdir -p $out/bin
            makeBinaryWrapper ${pkgs.nodejs}/bin/node $out/bin/grafana2matrix --chdir "$out/lib/grafana2matrix" --add-flags "$out/lib/grafana2matrix/src/index.js"

            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "A bridge between Grafana Alerting and Matrix";
            homepage = "https://github.com/amaennel/grafana2matrix";
            license = licenses.mit;
            maintainers = [ ];
            platforms = platforms.linux;
          };
        };

      in
      {
        packages = {
          default = grafana2matrix;
          grafana2matrix = grafana2matrix;
        };

        # Development shell
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            pkgs.nodejs
            nodePackages.npm
          ];
        };
      }
    ) // {
      nixosModules.default = { config, lib, pkgs, ... }:
        with lib;
        let
          cfg = config.services.grafana2matrix;
        in
        {
          options.services.grafana2matrix = {
            enable = mkEnableOption "Grafana to Matrix webhook adapter";

            package = mkOption {
              type = types.package;
              default = self.packages.${pkgs.system}.default;
              description = "The grafana2matrix package to use";
            };

            environmentFile = mkOption {
              type = types.path;
              default = "/etc/grafana2matrix/env";
              description = "Path to the environment file defining at least MATRIX_ACCESS_TOKEN and optionally GRAFANA_API_KEY. Can be used to overwrite all options.";
            };

            port = mkOption {
              type = types.port;
              default = 3000;
              description = "Port to listen on";
            };

            matrixHomeserverUrl = mkOption {
              type = types.str;
              example = "https://matrix.org";
              description = "Matrix homeserver URL";
            };

            matrixRoomId = mkOption {
              type = types.str;
              example = "!roomid:matrix.org";
              description = "Matrix room ID to send notifications to";
            };

            grafanaUrl = mkOption {
              type = types.str;
              example = "https://your-grafana-instance.com";
              description = "Grafana instance URL (required for Silencing)";
            };

            mentionConfig = mkOption {
              type = types.nullOr (
                types.attrsOf (
                  types.submodule {
                    options = {
                      primary = mkOption {
                        type = types.listOf types.str;
                        default = [ ];
                        example = [ "@user1:matrix.org" ];
                        description = "Primary users to mention";
                      };

                      secondary = mkOption {
                        type = types.listOf types.str;
                        default = [ ];
                        example = [ "@user2:matrix.org" ];
                        description = "Secondary users to mention";
                      };

                      delay_crit_primary = mkOption {
                        type = types.int;
                        default = 0;
                        example = 0;
                        description = "Delay in minutes before mentioning primary users for CRIT alerts (0 = immediate, -1 = never)";
                      };

                      delay_warn_primary = mkOption {
                        type = types.int;
                        default = 30;
                        example = 30;
                        description = "Delay in minutes before mentioning primary users for WARN alerts (0 = immediate, -1 = never)";
                      };

                      delay_crit_secondary = mkOption {
                        type = types.int;
                        default = 60;
                        example = 60;
                        description = "Delay in minutes before mentioning secondary users for CRIT alerts (0 = immediate, -1 = never)";
                      };

                      delay_warn_secondary = mkOption {
                        type = types.int;
                        default = -1;
                        example = -1;
                        description = "Delay in minutes before mentioning secondary users for WARN alerts (0 = immediate, -1 = never)";
                      };

                      repeat_crit_primary = mkOption {
                        type = types.nullOr types.int;
                        default = null;
                        example = 60;
                        description = "Repeat mention every N minutes for CRIT (null = every grafana summary, -1 = once)";
                      };

                      repeat_warn_primary = mkOption {
                        type = types.nullOr types.int;
                        default = -1;
                        example = -1;
                        description = "Repeat mention every N minutes for WARN (null = every grafana summary, -1 = once)";
                      };
                    };
                  }
                )
              );
              default = null;
              example = {
                "host-01" = {
                  primary = [ "@user1:matrix.org" ];
                  secondary = [ "@user2:matrix.org" ];
                  delay_crit_primary = 0;
                  delay_warn_primary = 60;
                  delay_crit_secondary = 60;
                  delay_warn_secondary = -1;
                  repeat_crit_primary = 60;
                  repeat_warn_primary = -1;
                };
              };
              description = "Mention configuration per host. Key must exactly match the 'host' label value from Grafana alerts.";
            };

            summaryScheduleCrit = mkOption {
              type = types.nullOr types.str;
              default = null;
              example = "08:00,16:00";
              description = "UTC times for critical alert summaries (comma-separated)";
            };

            summaryScheduleWarn = mkOption {
              type = types.nullOr types.str;
              default = null;
              example = "08:00";
              description = "UTC times for warning alert summaries (comma-separated)";
            };

            summaryScheduleSkipEmpty = mkOption {
              type = types.nullOr types.bool;
              default = null;
              example = "true";
              description = "Do not send empty scheduled alert summaries if true";
            };

            dbFilename = mkOption {
              type = types.str;
              default = "alerts.db";
              description = "Path to SQLite database file inside of the service StateDirectory";
            };

            stateDirectory = mkOption {
              type = types.str;
              default = "grafana2matrix";
              description = "Directory name used for persistent files under /var/lib/";
            };

            user = mkOption {
              type = types.str;
              default = "grafana2matrix";
              description = "User to run the service as";
            };

            group = mkOption {
              type = types.str;
              default = "grafana2matrix";
              description = "Group to run the service as";
            };
          };

          config = mkIf cfg.enable {
            # Systemd service and configuration via environment variables
            systemd.services.grafana2matrix =
              let
                # Create config.json for grafana2matrix
                configJson = pkgs.writeText "config.json" (
                  builtins.toJSON (
                    {
                      PORT = toString cfg.port;
                      MATRIX_HOMESERVER_URL = toString cfg.matrixHomeserverUrl;
                      MATRIX_ROOM_ID = toString cfg.matrixRoomId;
                      DB_FILE = "/var/lib/${cfg.stateDirectory}/${cfg.dbFilename}";
                    } // optionalAttrs (cfg.grafanaUrl != null) {
                      GRAFANA_URL = toString cfg.grafanaUrl;
                    } // optionalAttrs (cfg.mentionConfig != null) {
                      MENTION_CONFIG_PATH = pkgs.writeText "mention-config.json" (builtins.toJSON cfg.mentionConfig);
                    } // optionalAttrs (cfg.summaryScheduleCrit != null) {
                      SUMMARY_SCHEDULE_CRIT = toString cfg.summaryScheduleCrit;
                    } // optionalAttrs (cfg.summaryScheduleWarn != null) {
                      SUMMARY_SCHEDULE_WARN = toString cfg.summaryScheduleWarn;
                    } // optionalAttrs (cfg.summaryScheduleSkipEmpty != null) {
                      SUMMARY_SCHEDULE_SKIP_EMPTY = cfg.summaryScheduleSkipEmpty;
                    }
                  )
                );
              in
              {
                description = "Grafana to Matrix webhook adapter";
                wantedBy = [ "multi-user.target" ];
                after = [ "network-online.target" ];
                wants = [ "network-online.target" ];

                serviceConfig = {
                  Type = "simple";
                  User = cfg.user;
                  Group = cfg.group;
                  Restart = "always";
                  RestartSec = "10s";

                  # Security hardening
                  NoNewPrivileges = true;
                  PrivateTmp = true;
                  ProtectSystem = "strict";
                  ProtectKernelTunables = true;
                  ProtectKernelModules = true;
                  ProtectControlGroups = true;
                  PrivateDevices = true;
                  RestrictSUIDSGID = true;
                  ProtectHome = true;

                  EnvironmentFile = "${cfg.environmentFile}";

                  WorkingDirectory = "${cfg.package}/lib/grafana2matrix";
                  StateDirectory = "${cfg.stateDirectory}";

                  ExecStart = "${cfg.package}/bin/grafana2matrix --config ${configJson}";
                };
              };

            users.users.${cfg.user} = {
              isSystemUser = true;
              group = cfg.group;
              description = "grafana2matrix service user";
            };

            users.groups.${cfg.group} = { };
          };
        };
    };
}
