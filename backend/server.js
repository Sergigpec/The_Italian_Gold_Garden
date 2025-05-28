'use strict';

require('dotenv').config();

//Dependencias
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const socketIo = require('socket.io');
const mysql = require('mysql2/promise');

// Crear servidor HTTP con Express
const app = express();
const server = http.createServer(app);
const allowedOrigins = [
    'http://127.0.0.1:5500',
    'http://127.0.0.1:5501',
    'http://localhost:5500',
    'http://localhost:5501',
    'https://the-italian-gold-garden.onrender.com'
];


const io = socketIo(server, {
    cors: {
        // Lista de orígenes permitidas
        origin: allowedOrigins,
        // Métodos HTTP permitidos
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        // Cabeceras que se puede recibir en la petición
        allowedHeaders: ['Content-Type', 'Authorization'],
        // Permite envío de cookies
        Credentials: true
    }
});

// Configuración Puerto
const PORT = process.env.PORT || 3000;

// Configuración de middlewares
app.use(cors({
    origin: allowedOrigins,
    credentials: true
})); // Habilita CORS
app.use(express.json()); // Parsea datos JSON en las solicitudes
// Sirve archivos estáticos
app.use(express.static(path.join(__dirname, '..', 'public')));



// Agregar configuración de base de datos
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    port: process.env.DB_PORT,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0

});

pool.getConnection()
    .then(connection => {
        console.log('Conexión a MySQL exitosa!');
        connection.release(); // Libera la conexión del pool
    })
    .catch(err => {
        console.error('Error de conexión a MySQL:', err.message);
        process.exit(1); // Detener la app si hay error de conexión
    });

// Manejo de errores
pool.on('error', err => {
    console.error('⚠️ Error en el pool de MySQL:', err.message);
});


module.exports = pool;

// WebSocket
io.on('connection', (socket) => {
    console.log('Nuevo cliente conectado:', socket.id);

    socket.on('unirsePedido', (pedidoId) => {
        socket.join(`pedido_${pedidoId}`);
        console.log(`Cliente unido al pedido ${pedidoId}`);
    });

    socket.on('unirseCocina', () => {
    socket.join('cocina');
    console.log(`Cocina conectada: ${socket.id}`);
    });

    socket.on('disconnect', () => {
        console.log('Cliente desconectado:', socket.id);
    });

});

// GET Maneja solicitudes GET a la ruta /api/menu
app.get('/api/menu', async (req, res) => {

    const connection = await pool.getConnection();
    try {
        // Consulta SQL
        const [platos] = await connection.query(`
        SELECT
            id, nombre, descripcion, precio, categoria,
            IFNULL(NULLIF(imagen, ''), 'placeholder-food.jpg') AS imagen
        FROM platos
        WHERE activo = 1
        ORDER BY categoria, nombre
    `);

        // Organizacion del menu 
        const menuData = {
            bebidas: platos.filter(p => p.categoria === 'bebidas'),
            entrantes: platos.filter(p => p.categoria === 'entrantes'),
            frituras: platos.filter(p => p.categoria === 'frituras'),
            pastas: platos.filter(p => p.categoria === 'pastas'),
            pizzas: platos.filter(p => p.categoria === 'pizzas'),
            allItems: platos
        };
        res.json(menuData);

    } catch (error) {
        console.error('Error al obtener el menú:', error);
        res.status(500).json({ error: 'Error al cargar el menú' });
    } finally {
        connection.release();
    }
});

// GET /api/pedidos filtrado por estado
app.get('/api/pedidos', async (req, res) => {

    const estadosParam = req.query.estado;
    if (!estadosParam) {
        return res.status(400).json({ message: 'Falta el parámetro estado' });
    }

    // Pasar a array , separando comas y posibles entradas vacias
    const estados = estadosParam.split(',').map(e => e.trim()).filter(e => e);

    if (estados.length === 0) {
        return res.status(400).json({ message: 'Parámetro estado inválido' });
    }

    let conn;

    try {

        conn = await pool.getConnection();
        const placeholders = estados.map(() => '?').join(',');

        // Trae los pedidos cuyo estado esta en 'estados'
        const [pedidosRows] = await conn.query(`
      SELECT 
        p.id,
        p.mesa_id,
        p.cliente_id,
        p.estado,
        p.notas,
        DATE_FORMAT(p.fecha_pedido, '%Y-%m-%dT%H:%i:%s.000Z') AS fecha_pedido
      FROM pedidos p
      WHERE p.estado IN (${placeholders})
      ORDER BY p.fecha_pedido ASC
    `, estados);



        const pedidosConItems = await Promise.all(pedidosRows.map(async p => {
            const [items] = await conn.query(`
        SELECT dp.plato_id AS id,
               pl.nombre,
               dp.cantidad,
               dp.precio_unitario AS precio
        FROM detalle_pedido dp
        JOIN platos pl ON pl.id = dp.plato_id
        WHERE dp.pedido_id = ?
      `, [p.id]);

            return { ...p, items };
        }));

        res.json(pedidosConItems);
    } catch (err) {
        console.error('Error al cargar pedidos:', err);
        res.status(500).json({ message: 'Error al cargar pedidos' });
    } finally {
        if (conn) conn.release();
    }
});

// POST /api/pedidos filtrado por estado
app.post('/api/pedidos', async (req, res) => {

    console.log()
    const { cliente, telefono = '', notas, items, total, estado, mesa_id } = req.body;

    if (!mesa_id || !cliente || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: 'Datos de pedido incompletos' });
    }

    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const [clienteRes] = await conn.query(
            'INSERT INTO clientes (nombre, telefono) VALUES (?, ?)',
            [cliente, telefono]
        );

        const clienteId = clienteRes.insertId;

        const [pedidoRes] = await conn.query(
            `INSERT INTO pedidos
         (mesa_id, cliente_id, total, estado, notas)
       VALUES (?, ?, ?, ?, ?)`,
            [mesa_id, clienteId, parseFloat(total), estado || 'recibido', notas || '']
        );

        const pedidoId = pedidoRes.insertId;

        const detalles = items.map(it => [
            pedidoId,
            it.id,
            it.cantidad,
            parseFloat(it.precio),
            parseFloat(it.precio) * it.cantidad
        ]);

        await conn.query(
            `INSERT INTO detalle_pedido
         (pedido_id, plato_id, cantidad, precio_unitario, subtotal)
       VALUES ?`,
            [detalles]
        );

        await conn.commit();

        const [pedidoFull] = await conn.query(
            `SELECT p.id, p.mesa_id, p.cliente_id, p.estado, p.notas, p.fecha_pedido,
              JSON_ARRAYAGG(
                JSON_OBJECT(
                  'id', dp.plato_id,
                  'cantidad', dp.cantidad,
                  'precio', dp.precio_unitario
                )
              ) AS items
       FROM pedidos p
       JOIN detalle_pedido dp ON p.id = dp.pedido_id
       WHERE p.id = ?
       GROUP BY p.id`,
            [pedidoId]
        );

        io.to('cocina').emit('nuevoPedido', pedidoFull[0]);
        io.to(`pedido_${pedidoId}`).emit('actualizacionEstado', { pedidoId, estado: estado || 'recibido' });

        res.json({ success: true, pedidoId });

    } catch (err) {
        if (conn) await conn.rollback();
        console.error('Error al procesar pedido:', err);
        res.status(500).json({ message: err.message || 'Error al procesar el pedido' });
    } finally {
        if (conn) conn.release();
    }
});

// PUT /api/pedidos/:id/estado
app.put('/api/pedidos/:id/estado', async (req, res) => {
    const pedidoId = parseInt(req.params.id);
    const { estado } = req.body;

    if (isNaN(pedidoId)) {
        return res.status(400).json({ error: 'ID de pedido inválido' });
    }

    let conn;
    try {
        conn = await pool.getConnection();
        await conn.query(
            'UPDATE pedidos SET estado = ? WHERE id = ?',
            [estado, pedidoId]
        );

        // Emitir actualización WebSocket
        io.to(`pedido_${pedidoId}`).emit('actualizacionEstado', { pedidoId, estado });

        res.json({ success: true });
    } catch (err) {
        console.error('Error al actualizar estado del pedido:', err);
        res.status(500).json({ message: 'Error al actualizar estado del pedido' });
    } finally {
        if (conn) conn.release();
    }
});



server.listen(PORT, () => console.log(`Servidor corriendo en el puerto ${PORT}`));
