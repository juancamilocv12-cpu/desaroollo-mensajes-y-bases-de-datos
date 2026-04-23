module.exports = {
    apps: [
        {
            name: "meteoro",
            script: "src/index.js",
            cwd: __dirname,
            instances: 1,
            exec_mode: "fork",
            autorestart: true,
            watch: false,
            max_memory_restart: "500M",
            env: {
                NODE_ENV: "production",
            },
        },
    ],
};