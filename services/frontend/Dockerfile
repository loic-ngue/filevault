# ES-09 : image Nginx non root, écoute sur 8080.
FROM nginxinc/nginx-unprivileged:1.30-alpine
# Correctifs de sécurité des paquets Alpine (ES-10), puis retour à l'utilisateur nginx.
USER root
RUN apk upgrade --no-cache
USER 101
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public /usr/share/nginx/html
EXPOSE 8080
