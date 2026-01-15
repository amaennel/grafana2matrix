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

        grafana2matrix = pkgs.buildNpmPackage rec {
          pname = "grafana2matrix";
          version = "0.1.6";

          src = pkgs.fetchFromGitHub {
            owner = "amaennel";
            repo = pname;
            rev = version;
            hash = "sha256-LQOU9Uf6bkPRXFyvWHsJ3gyqUwB9ZU4kmp7Vq1bKu0c=";
          };

          npmDepsHash = "sha256-yUDZJSufT7ZgJS0YwJroPutV238ppfvGBQhPQ1fzwOo=";

          nodejs = pkgs.nodejs_22;

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
            cat > $out/bin/grafana2matrix <<EOF
            #!${pkgs.bash}/bin/bash
            cd $out/lib/grafana2matrix
            exec ${pkgs.nodejs_22}/bin/node src/index.js "\$@"
            EOF
            chmod +x $out/bin/grafana2matrix

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

        apps = {
          default = {
            type = "app";
            program = "${grafana2matrix}/bin/grafana2matrix";
          };
        };

        # Development shell
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs_22
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

            matrixAccessToken = mkOption {
              type = types.str;
              description = "Matrix access token";
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

            grafanaApiKey = mkOption {
              type = types.str;
              description = "Grafana API key";
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
            systemd.services.grafana2matrix = {
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

                WorkingDirectory = "${cfg.package}/lib/grafana2matrix";
                StateDirectory = "${cfg.stateDirectory}";

                ExecStart = pkgs.writeShellScript "grafana2matrix-start" ''
                  export PORT=${toString cfg.port}
                  export MATRIX_HOMESERVER_URL="${cfg.matrixHomeserverUrl}"
                  export MATRIX_ACCESS_TOKEN="${cfg.matrixAccessToken}"
                  export MATRIX_ROOM_ID="${cfg.matrixRoomId}"
                  export DB_FILE="/var/lib/${cfg.stateDirectory}/${cfg.dbFilename}"

                  ${optionalString (cfg.grafanaUrl != null) ''
                    export GRAFANA_URL="${cfg.grafanaUrl}"
                  ''}
                  ${optionalString (cfg.grafanaApiKey != null) ''
                    export GRAFANA_API_KEY="${cfg.grafanaApiKey}"
                  ''}
                  ${optionalString (cfg.mentionConfig != null) ''
                    # File mention-config.json is created with contents of option mentionConfig
                    export MENTION_CONFIG_PATH="${pkgs.writeText "mention-config.json" (builtins.toJSON cfg.mentionConfig)}"
                  ''}
                  ${optionalString (cfg.summaryScheduleCrit != null) ''
                    export SUMMARY_SCHEDULE_CRIT="${cfg.summaryScheduleCrit}"
                  ''}
                  ${optionalString (cfg.summaryScheduleWarn != null) ''
                    export SUMMARY_SCHEDULE_WARN="${cfg.summaryScheduleWarn}"
                  ''}

                  exec ${pkgs.nodejs_22}/bin/node src/index.js
                '';
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
