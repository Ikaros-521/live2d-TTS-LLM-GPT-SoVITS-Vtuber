const express = require("express");
const cors = require('cors');
const fs = require("fs");
var ejs = require("ejs");
const path = require("path");
const { promisify } = require('util');
const app = express();
const multer = require("multer");
const { EdgeTTS } = require("node-edge-tts");
const WebSocket = require('ws');
const stream = require('stream');

// 创建 Node.js Stream 的 Promise 版本
const pipeline = promisify(stream.pipeline);

// 允许所有来源
app.use(cors({
  origin: '*', // 允许所有源
}));
app.use(express.json()); // 用于解析 JSON 请求体

// 这边写死了ws端口，要改的话请同步修改前端连接的ws端口
const wss = new WebSocket.Server({ port: 22336 });
// 存储所有 WebSocket 连接
let ws_clients = [];
// 项目中的 'out' 文件夹，存储音频文件
const outDir = path.join(__dirname, 'out'); 
// 确保 'out' 文件夹存在
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir);
}

// 配置静态文件服务
app.use('/out', express.static(outDir));


// 处理 WebSocket 连接
wss.on('connection', ws => {
  console.log('Client connected via WebSocket');
  ws_clients.push(ws); // 将新连接添加到 ws_clients 数组

  // 处理收到的消息
  ws.on('message', async (message) => {
    try {
      const parsedMessage = JSON.parse(message);
    } catch (error) {
      console.error('Failed to process message:', error);
    }
  });

  // 处理连接关闭
  ws.on('close', () => {
    console.log('Client disconnected');
    ws_clients = ws_clients.filter(client => client !== ws);
  });

  // 发送初始化消息到客户端
  ws.send(JSON.stringify({ action: 'status', data: '连接成功' }));
});

// 保存音频文件
async function saveAudioFile(audioPath, outputPath) {
  const fileStream = fs.createWriteStream(outputPath);

  // 使用 HTTP 请求下载文件并写入到本地文件
  const response = await fetch(audioPath);
  if (!response.ok) throw new Error(`Failed to fetch ${audioPath}: ${response.statusText}`);

  await pipeline(response.body, fileStream);
}

// ws接口 配合ai-vtb协同控制talk函数的调用，来实现音频驱动口型
/*
  请求体 参考：
    {
      "action": "talk",
      "data": {
        "audio_path": "http://127.0.0.1:8081/out/1.wav"
      }
    }
*/
app.post('/ws', async (req, res) => {
  const message_json = req.body;

  // console.log(message_json);

  if (message_json.action === 'talk') {
    console.log("请求talk方法");
    const audioPath = message_json.data.audio_path;
    const audioUrl = path.join(outDir, path.basename(audioPath));

    // 下载并保存音频文件
    await saveAudioFile(audioPath, audioUrl);

    // 生成 Linux 风格的相对路径
    let relativeAudioPath = path.relative(__dirname, audioUrl);

    // 将路径中的反斜杠替换为正斜杠，并确保路径以 './' 开头
    // relativeAudioPath = relativeAudioPath.replace(/\\/g, '/');
    // if (!relativeAudioPath.startsWith('./')) {
    //   relativeAudioPath = `./${relativeAudioPath}`;
    // }

    ws_clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ action: 'talk', audio_path: relativeAudioPath }));
      }
    });
  }

  res.status(200).json({ message: '广播数据到所有WS客户端成功' });
});



app.listen(3000, () => {
  console.log("Application started and Listening on port 3000");
  console.log("请打开浏览器，访问 http://localhost:3000 ");
});

// 设置存储引擎和文件上传路径
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "./uploads/"); // 将上传的文件存储在 uploads 文件夹中
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname); // 获取文件原始扩展名
    cb(null, file.fieldname + ext); // 使用原始扩展名生成文件名
  },
});

// serve your css as static
app.use(express.static(__dirname));

//设置html模板渲染引擎
app.engine("html", ejs.__express);
//设置渲染引擎为html
app.set("view engine", "html");

// 创建 multer 实例
const upload = multer({ storage: storage });

// 上传文件
app.post("/upload", upload.single("image"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "未上传文件" });
  }
  res.json({ message: "文件上传成功", filename: req.file.filename });
});

// edge_tts接口
app.get("/edge_tts", async (req, res) => {
  var speaker = req.query.speaker || "zh-CN-XiaoxiaoNeural";

  var text = req.query.text || "你好哟,这里是测试";

  const tts = new EdgeTTS({
    voice: speaker,
  });

  await tts.ttsPromise(text, "output.wav");

  fs.readFile("output.wav", (err, data) => {
    if (err) {
      console.error("读取文件错误:", err);
      res.status(500).send("服务器内部错误");
      return;
    }

    // 将音频数据编码为 Base64
    const base64Audio = Buffer.from(data).toString("base64");

    // 将 Base64 编码的音频数据发送到前端
    res.send({ audio: base64Audio });
  });
});

// 修改json接口

app.get("/edit_config", (req, res) => {
  var model_path = req.query.model_path;

  var filePath = "./config.json";

  // 读取文件内容
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) {
      res.status(500).send("Error reading file");
    } else {
      var data = '{"model_path":"' + model_path + '"}';

      console.log(data);

      // 写入修改后的内容到文件
      fs.writeFile(filePath, data, "utf8", (err) => {
        if (err) {
          res.status(500).send("Error writing file");
        } else {
          res.status(200).send("File updated successfully");
        }
      });
    }
  });
});

// 文字转语音 页面操作
app.get("/tts", (req, res) => {
  var filePath = "./config.json";

  // 同步地遍历目录并返回目录名
  function getSubdirectories(dirPath) {
    return new Promise((resolve, reject) => {
      fs.readdir(dirPath, { withFileTypes: true }, (err, files) => {
        if (err) {
          return reject(err);
        }

        // 过滤出目录项
        const directories = files
          .filter((file) => file.isDirectory())
          .map((file) => file.name);

        resolve(directories);
      });
    });
  }

  // 指定目标目录路径
  const targetDir = "./models/";

  var dis;

  // 获取目标目录下的所有目录名
  getSubdirectories(targetDir)
    .then((directories) => {
      dis = directories;
    })
    .catch((err) => {
      console.error(err);
    });

  // 读取文件内容
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) {
      res.status(500).send("Error reading file,配置文件不存在");
    } else {
      console.log(data);

      const jsonData = JSON.parse(data);
      const modelPath = jsonData.model_path;

      dis = JSON.stringify(dis);

      res.render(__dirname + "/live2d_test", {
        model_path: modelPath,
        model_list: dis,
      });
    }
  });
});

// 大模型 页面操作
app.get("/llm", (req, res) => {
  var filePath = "./config.json";

  // 同步地遍历目录并返回目录名
  function getSubdirectories(dirPath) {
    return new Promise((resolve, reject) => {
      fs.readdir(dirPath, { withFileTypes: true }, (err, files) => {
        if (err) {
          return reject(err);
        }

        // 过滤出目录项
        const directories = files
          .filter((file) => file.isDirectory())
          .map((file) => file.name);

        resolve(directories);
      });
    });
  }

  // 指定目标目录路径
  const targetDir = "./models/";

  var dis;

  // 获取目标目录下的所有目录名
  getSubdirectories(targetDir)
    .then((directories) => {
      dis = directories;
    })
    .catch((err) => {
      console.error(err);
    });

  // 读取文件内容
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) {
      res.status(500).send("Error reading file,配置文件不存在");
    } else {
      console.log(data);

      const jsonData = JSON.parse(data);
      const modelPath = jsonData.model_path;

      dis = JSON.stringify(dis);

      res.render(__dirname + "/live2d_llm", {
        model_path: modelPath,
        model_list: dis,
      });
    }
  });
});

app.get("/", (req, res) => {
  res.render(__dirname + "/index");
});

// 文字转语音 edge页面操作
app.get("/tts_edge", (req, res) => {
  var filePath = "./config.json";

  // 同步地遍历目录并返回目录名
  function getSubdirectories(dirPath) {
    return new Promise((resolve, reject) => {
      fs.readdir(dirPath, { withFileTypes: true }, (err, files) => {
        if (err) {
          return reject(err);
        }

        // 过滤出目录项
        const directories = files
          .filter((file) => file.isDirectory())
          .map((file) => file.name);

        resolve(directories);
      });
    });
  }

  // 指定目标目录路径
  const targetDir = "./models/";

  var dis;

  // 获取目标目录下的所有目录名
  getSubdirectories(targetDir)
    .then((directories) => {
      dis = directories;
    })
    .catch((err) => {
      console.error(err);
    });

  // 读取文件内容
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) {
      res.status(500).send("Error reading file,配置文件不存在");
    } else {
      console.log(data);

      const jsonData = JSON.parse(data);
      const modelPath = jsonData.model_path;

      dis = JSON.stringify(dis);

      res.render(__dirname + "/live2d_edge_tts", {
        model_path: modelPath,
        model_list: dis,
      });
    }
  });
});

// 大模型 edge_tts
app.get("/llm_edge_tts", (req, res) => {
  var filePath = "./config.json";

  // 同步地遍历目录并返回目录名
  function getSubdirectories(dirPath) {
    return new Promise((resolve, reject) => {
      fs.readdir(dirPath, { withFileTypes: true }, (err, files) => {
        if (err) {
          return reject(err);
        }

        // 过滤出目录项
        const directories = files
          .filter((file) => file.isDirectory())
          .map((file) => file.name);

        resolve(directories);
      });
    });
  }

  // 指定目标目录路径
  const targetDir = "./models/";

  var dis;

  // 获取目标目录下的所有目录名
  getSubdirectories(targetDir)
    .then((directories) => {
      dis = directories;
    })
    .catch((err) => {
      console.error(err);
    });

  // 读取文件内容
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) {
      res.status(500).send("Error reading file,配置文件不存在");
    } else {
      console.log(data);

      const jsonData = JSON.parse(data);
      const modelPath = jsonData.model_path;

      dis = JSON.stringify(dis);

      res.render(__dirname + "/live2d_llm_edge_tts", {
        model_path: modelPath,
        model_list: dis,
      });
    }
  });
});
