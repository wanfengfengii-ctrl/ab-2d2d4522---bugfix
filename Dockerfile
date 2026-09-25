# 古建筑墙面饰砖空鼓联合反演服务
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# 项目零第三方依赖，直接拷贝源码即可运行
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY test ./test
# 拷贝部署描述文件，使镜像内的构建检查（scripts/check.js）可完整核对项目结构
COPY Dockerfile docker-compose.yml ./

ENV PORT=3000
EXPOSE 3000

# 容器级健康检查：业务健康端点必须返回 2xx
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
