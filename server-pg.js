const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const XLSX = require('xlsx');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Create tables
async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            empId TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            password TEXT NOT NULL,
            role TEXT NOT NULL,
            department TEXT NOT NULL,
            privilege INTEGER DEFAULT 1,
            joiningDate DATE DEFAULT CURRENT_DATE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    await pool.query(`
        CREATE TABLE IF NOT EXISTS training_modules (
            id SERIAL PRIMARY KEY,
            department TEXT NOT NULL,
            moduleName TEXT NOT NULL,
            UNIQUE(department, moduleName)
        )
    `);
    
    await pool.query(`
        CREATE TABLE IF NOT EXISTS nurse_training (
            id SERIAL PRIMARY KEY,
            nurseId TEXT NOT NULL,
            moduleName TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            completedAt TIMESTAMP,
            FOREIGN KEY (nurseId) REFERENCES users(empId)
        )
    `);
    
    await pool.query(`
        CREATE TABLE IF NOT EXISTS evaluations (
            id SERIAL PRIMARY KEY,
            nurseId TEXT NOT NULL,
            type TEXT NOT NULL,
            score INTEGER,
            answers TEXT,
            completedAt TIMESTAMP,
            FOREIGN KEY (nurseId) REFERENCES users(empId)
        )
    `);
    
    await pool.query(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id SERIAL PRIMARY KEY,
            userId TEXT NOT NULL,
            userName TEXT NOT NULL,
            action TEXT NOT NULL,
            details TEXT,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Insert default users
    const defaultUsers = [
        ['ADMIN999', 'System Admin', bcrypt.hashSync('Admin@2025', 10), 'admin', 'All', 3],
        ['MGR001', 'Mary Thompson', bcrypt.hashSync('manager123', 10), 'manager', 'ICU', 3],
        ['SUP001', 'James Wilson', bcrypt.hashSync('super123', 10), 'supervisor', 'ICU', 2],
        ['NURSE101', 'Sarah Johnson', bcrypt.hashSync('nurse123', 10), 'nurse', 'ICU', 1],
        ['NURSE102', 'Michael Chen', bcrypt.hashSync('nurse123', 10), 'nurse', 'OT', 2],
        ['NURSE103', 'Emma Davis', bcrypt.hashSync('nurse123', 10), 'nurse', 'Infection Control', 3],
        ['NURSE104', 'Priya Sharma', bcrypt.hashSync('nurse123', 10), 'nurse', 'ICU', 1]
    ];
    
    for (const user of defaultUsers) {
        await pool.query(`
            INSERT INTO users (empId, name, password, role, department, privilege)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (empId) DO NOTHING
        `, user);
    }
    
    // Insert training modules
    const trainingModules = {
        "ICU": [
            "ICU Basic Life Support (BLS)", "ICU Advanced Cardiac Life Support (ACLS)",
            "ICU Ventilator Management", "ICU Hemodynamic Monitoring", "ICU Central Line Care",
            "ICU Sedation and Analgesia Protocols", "ICU Infection Control Bundle",
            "ICU Rapid Response Team Activation", "ICU End of Life Care", "ICU Handoff Communication (SBAR)"
        ],
        "OT": [
            "OT Surgical Scrub Techniques", "OT Sterile Field Setup", "OT Surgical Safety Checklist",
            "OT Instrument Sterilization", "OT Counts (Sponge, Needle, Instrument)", "OT Waste Management",
            "OT Anesthesia Equipment Handling", "OT Emergency Protocols", "OT Pre-op Patient Verification",
            "OT Post-op Instrument Care"
        ],
        "Infection Control": [
            "Hand Hygiene Compliance (WHO 5 Moments)", "Personal Protective Equipment (PPE) Use",
            "Isolation Precautions", "Medical Waste Segregation & Disposal", "Needlestick Injury Prevention",
            "Environmental Cleaning & Disinfection", "Surveillance of HAIs", "Antibiotic Stewardship Basics",
            "Outbreak Management", "Sterilization & High-Level Disinfection"
        ]
    };
    
    for (const [dept, modules] of Object.entries(trainingModules)) {
        for (const module of modules) {
            await pool.query(`
                INSERT INTO training_modules (department, moduleName)
                VALUES ($1, $2)
                ON CONFLICT (department, moduleName) DO NOTHING
            `, [dept, module]);
        }
    }
    
    console.log('✅ Database initialized');
}

initDB();

// ========== API ROUTES ==========

// Login
app.post('/api/login', async (req, res) => {
    const { empId, password } = req.body;
    const result = await pool.query(`SELECT * FROM users WHERE empId = $1`, [empId]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (bcrypt.compareSync(password, user.password)) {
        const token = jwt.sign({ empId: user.empId, role: user.role }, process.env.JWT_SECRET || 'secretkey', { expiresIn: '8h' });
        res.json({ token, user: { empId: user.empId, name: user.name, role: user.role, department: user.department, privilege: user.privilege } });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

// Get all nurses
app.get('/api/nurses', async (req, res) => {
    const result = await pool.query(`SELECT * FROM users WHERE role IN ('nurse', 'supervisor', 'manager')`);
    res.json(result.rows);
});

// Get nurse by ID
app.get('/api/nurses/:empId', async (req, res) => {
    const result = await pool.query(`SELECT * FROM users WHERE empId = $1`, [req.params.empId]);
    res.json(result.rows[0]);
});

// Add/Update nurse
app.post('/api/nurses', async (req, res) => {
    const { empId, name, password, role, department, privilege } = req.body;
    const hashedPassword = bcrypt.hashSync(password, 10);
    await pool.query(`
        INSERT INTO users (empId, name, password, role, department, privilege, joiningDate)
        VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE)
        ON CONFLICT (empId) DO UPDATE SET name = $2, password = $3, role = $4, department = $5, privilege = $6
    `, [empId, name, hashedPassword, role, department, privilege]);
    res.json({ success: true });
});

// Delete nurse
app.delete('/api/nurses/:empId', async (req, res) => {
    await pool.query(`DELETE FROM users WHERE empId = $1`, [req.params.empId]);
    res.json({ success: true });
});

// Get training for a nurse
app.get('/api/training/:nurseId', async (req, res) => {
    const deptResult = await pool.query(`SELECT department FROM users WHERE empId = $1`, [req.params.nurseId]);
    const department = deptResult.rows[0]?.department || 'ICU';
    const modules = await pool.query(`
        SELECT tm.moduleName, nt.status, nt.completedAt
        FROM training_modules tm
        LEFT JOIN nurse_training nt ON nt.moduleName = tm.moduleName AND nt.nurseId = $1
        WHERE tm.department = $2
        ORDER BY tm.id
    `, [req.params.nurseId, department]);
    res.json(modules.rows);
});

// Update training completion
app.post('/api/training/complete', async (req, res) => {
    const { nurseId, moduleName, status } = req.body;
    await pool.query(`
        INSERT INTO nurse_training (nurseId, moduleName, status, completedAt)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (nurseId, moduleName) DO UPDATE SET status = $3, completedAt = CURRENT_TIMESTAMP
    `, [nurseId, moduleName, status]);
    res.json({ success: true });
});

// Save evaluation
app.post('/api/evaluation', async (req, res) => {
    const { nurseId, type, score, answers } = req.body;
    await pool.query(`
        INSERT INTO evaluations (nurseId, type, score, answers, completedAt)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
    `, [nurseId, type, score, JSON.stringify(answers)]);
    res.json({ success: true });
});

// Get evaluation
app.get('/api/evaluation/:nurseId/:type', async (req, res) => {
    const result = await pool.query(`
        SELECT * FROM evaluations WHERE nurseId = $1 AND type = $2 ORDER BY completedAt DESC LIMIT 1
    `, [req.params.nurseId, req.params.type]);
    res.json(result.rows[0]);
});

// Add audit log
app.post('/api/audit', async (req, res) => {
    const { userId, userName, action, details } = req.body;
    await pool.query(`
        INSERT INTO audit_logs (userId, userName, action, details, timestamp)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
    `, [userId, userName, action, details]);
    res.json({ success: true });
});

// Get audit logs
app.get('/api/audit', async (req, res) => {
    const result = await pool.query(`SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 500`);
    res.json(result.rows);
});

// Bulk import
const upload = multer({ storage: multer.memoryStorage() });
app.post('/api/bulk-import', upload.single('file'), async (req, res) => {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);
    let imported = 0;
    for (const row of rows) {
        const empId = row.EmpId || row.empId;
        const name = row.Name || row.name;
        const department = row.Department || row.department || 'ICU';
        const role = row.Role || row.role || 'nurse';
        const privilege = parseInt(row.Privilege || row.privilege || 1);
        const password = bcrypt.hashSync(row.Password || row.password || 'nurse123', 10);
        const result = await pool.query(`
            INSERT INTO users (empId, name, password, role, department, privilege, joiningDate)
            VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE)
            ON CONFLICT (empId) DO NOTHING
        `, [empId, name, password, role, department, privilege]);
        if (result.rowCount > 0) imported++;
    }
    res.json({ success: true, imported });
});

app.get('/', (req, res) => {
    res.json({ message: 'SMARTCARE API is running!' });
});

app.listen(PORT, () => {
    console.log(`✅ SMARTCARE Backend running on http://localhost:${PORT}`);
});
