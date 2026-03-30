import { ZNL } from "@lyrify/znl";
import "../index.js";

const slave = new ZNL({
  role: "slave",
  id: "core-001",
  endpoints: {
    router: "tcp://127.0.0.1:6003",
  },
  authKey: "your-shared-key",
  encrypted: false,
});

async function run() {
  await slave.start();

  await slave.fs.enable({
    root: "./examples/storage",
  });

  console.log("slave ready: core-001");
}

run().catch((error) => {
  console.error("slave error:", error);
  process.exitCode = 1;
});
