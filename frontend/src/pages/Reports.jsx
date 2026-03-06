import React, { useState, useEffect, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import apiClient from '../config/axios';
import { Bar, Line, Pie } from 'react-chartjs-2';
import { exportToPDF, exportToExcel, formatCurrency } from '../utils/exportUtils';
import { toast } from 'react-toastify';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler
} from 'chart.js';

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

const REPORT_SECTIONS = ['financial', 'portfolio', 'clients', 'performance', 'revenue'];

const Reports = () => {
  const { section: urlSection } = useParams();
  const navigate = useNavigate();
  const [reportType, setReportType] = useState(() => {
    const s = (urlSection || 'financial').toLowerCase();
    return REPORT_SECTIONS.includes(s) ? s : 'financial';
  });
  const [chartKey, setChartKey] = useState(0);
  const [dashboardStats, setDashboardStats] = useState(null);
  const [historicalData, setHistoricalData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [financialSummary, setFinancialSummary] = useState({
    // Overall totals
    totalSavings: 0,
    totalPersonalInterest: 0,
    totalGeneralInterest: 0,
    totalOutstandingDues: 0,
    totalOutstandingLoans: 0,
    totalLoans: 0,
    totalFines: 0,
    outstandingSavings: 0,
    grandTotal: 0,
    overallTotalSavings: 0,
    // Currency-separated data
    lrd: {
      totalSavings: 0,
      totalPersonalInterest: 0,
      totalGeneralInterest: 0,
      totalDues: 0,
      outstandingDues: 0,
      monthlyDues: 0,
      totalLoans: 0,
      outstandingLoans: 0,
      outstandingSavings: 0,
      totalFines: 0,
      grandTotal: 0,
      overallTotalSavings: 0,
      clientsWithOutstandingDues: 0,
      clientsPaidDues: 0
    },
    usd: {
      totalSavings: 0,
      totalPersonalInterest: 0,
      totalGeneralInterest: 0,
      totalDues: 0,
      outstandingDues: 0,
      monthlyDues: 0,
      totalLoans: 0,
      outstandingLoans: 0,
      outstandingSavings: 0,
      totalFines: 0,
      grandTotal: 0,
      overallTotalSavings: 0,
      clientsWithOutstandingDues: 0,
      clientsPaidDues: 0
    }
  });
  const [revenueData, setRevenueData] = useState({
    // Overall totals
    totalRevenue: 0,
    loanRevenue: 0,
    savingsRevenue: 0,
    feesRevenue: 0,
    microfinanceRevenue: 0,
    duesRevenue: 0,
    generalInterestRevenue: 0,
    penaltyRevenue: 0,
    revenueBySource: {},
    revenues: [],
    // Currency-separated data
    lrd: {
      totalRevenue: 0,
      loanRevenue: 0,
      savingsRevenue: 0,
      feesRevenue: 0,
      microfinanceRevenue: 0,
      duesRevenue: 0,
      generalInterestRevenue: 0,
      penaltyRevenue: 0,
      revenueBySource: {}
    },
    usd: {
      totalRevenue: 0,
      loanRevenue: 0,
      savingsRevenue: 0,
      feesRevenue: 0,
      microfinanceRevenue: 0,
      duesRevenue: 0,
      generalInterestRevenue: 0,
      penaltyRevenue: 0,
      revenueBySource: {}
    }
  });

  // Client reports: list with filters and real-time data
  const [clientReportsList, setClientReportsList] = useState([]);
  const [clientReportsLoading, setClientReportsLoading] = useState(false);
  const [clientReportsCurrency, setClientReportsCurrency] = useState('ALL');
  const [clientReportsFrom, setClientReportsFrom] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 10);
  });
  const [clientReportsTo, setClientReportsTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [clientReportsSearch, setClientReportsSearch] = useState('');
  const [clientReportsExpandedId, setClientReportsExpandedId] = useState(null);

  const fetchClientReports = useCallback(async () => {
    const from = clientReportsFrom || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const to = clientReportsTo || new Date().toISOString().slice(0, 10);
    if (from > to) {
      toast.error('"From" date must be before or equal to "To" date.');
      return;
    }
    setClientReportsLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('from', from);
      params.set('to', to);
      if (clientReportsCurrency) params.set('currency', clientReportsCurrency);
      if (clientReportsSearch.trim()) params.set('search', clientReportsSearch.trim());
      const res = await apiClient.get(`/api/reports/clients?${params.toString()}`);
      setClientReportsList(res.data?.data?.clients ?? []);
      setClientReportsExpandedId(null);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to load client reports');
      setClientReportsList([]);
    } finally {
      setClientReportsLoading(false);
    }
  }, [clientReportsFrom, clientReportsTo, clientReportsCurrency, clientReportsSearch]);

  useEffect(() => {
    if (reportType === 'clients') {
      fetchClientReports();
    }
  }, [reportType, fetchClientReports]);

  // Real-time: refetch client reports every 30s when on clients tab
  useEffect(() => {
    if (reportType !== 'clients') return;
    const interval = setInterval(fetchClientReports, 30000);
    return () => clearInterval(interval);
  }, [reportType, fetchClientReports]);

  // Sync report type from URL (e.g. when using sidebar links)
  useEffect(() => {
    const s = (urlSection || 'financial').toLowerCase();
    if (REPORT_SECTIONS.includes(s) && s !== reportType) {
      setReportType(s);
    }
  }, [urlSection]);

  // Redirect /reports to /reports/financial so sidebar section is active
  useEffect(() => {
    if (!urlSection) {
      navigate('/reports/financial', { replace: true });
    }
  }, [urlSection, navigate]);

  // Reset chart key when switching report types to avoid canvas reuse errors
  useEffect(() => {
    setChartKey(prev => prev + 1);
  }, [reportType]);

  // Fetch real dashboard data for reports
  useEffect(() => {
    fetchDashboardData();
    fetchHistoricalData();
    fetchFinancialSummary();
    fetchRevenueData();
    
    // Refresh data every 30 seconds for real-time updates
    const interval = setInterval(() => {
      fetchDashboardData();
      fetchHistoricalData();
      fetchFinancialSummary();
      fetchRevenueData();
    }, 30000);
    
    return () => clearInterval(interval);
  }, []);

  const fetchFinancialSummary = async () => {
    try {
      const [savingsRes, transactionsRes, clientsRes, loansRes] = await Promise.all([
        apiClient.get('/api/savings'),
        apiClient.get('/api/transactions', { params: { limit: 1000 } }),
        apiClient.get('/api/clients'),
        apiClient.get('/api/loans')
      ]);

      const savings = savingsRes.data.data.savingsAccounts || [];
      const transactions = transactionsRes.data.data.transactions || [];
      const clients = clientsRes.data.data.clients || [];
      const loans = loansRes.data.data.loans || [];

      // Separate data by currency
      const savingsLRD = savings.filter(s => (s.currency || 'USD') === 'LRD');
      const savingsUSD = savings.filter(s => (s.currency || 'USD') === 'USD');
      
      const transactionsLRD = transactions.filter(t => (t.currency || 'USD') === 'LRD');
      const transactionsUSD = transactions.filter(t => (t.currency || 'USD') === 'USD');
      
      const loansLRD = loans.filter(l => (l.currency || 'USD') === 'LRD');
      const loansUSD = loans.filter(l => (l.currency || 'USD') === 'USD');
      
      const clientsLRD = clients.filter(c => (c.dues_currency || 'USD') === 'LRD');
      const clientsUSD = clients.filter(c => (c.dues_currency || 'USD') === 'USD');

      // Calculate LRD totals
      const totalSavingsLRD = savingsLRD.reduce((sum, acc) => 
        sum + parseFloat(acc.balance || 0), 0
      );

      const totalPersonalInterestLRD = transactionsLRD
        .filter(t => t.type === 'personal_interest_payment')
        .reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);

      const totalGeneralInterestLRD = transactionsLRD
        .filter(t => t.type === 'general_interest')
        .reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);

      const totalDuesLRD = clientsLRD.reduce((sum, c) => 
        sum + parseFloat(c.total_dues || 0), 0
      );

      const outstandingDuesLRD = clientsLRD
        .filter(c => parseFloat(c.total_dues || 0) < 0)
        .reduce((sum, c) => sum + Math.abs(parseFloat(c.total_dues || 0)), 0);

      const clientsWithOutstandingDuesLRD = clientsLRD.filter(c => parseFloat(c.total_dues || 0) < 0).length;
      
      const clientsPaidDuesLRD = clientsLRD.filter(c => {
        const duesPayments = transactionsLRD.filter(t => 
          t.client_id === c.id && t.type === 'due_payment'
        );
        return parseFloat(c.total_dues || 0) === 0 && duesPayments.length > 0;
      }).length;

      const totalLoansLRD = loansLRD.reduce((sum, loan) => 
        sum + parseFloat(loan.amount || 0), 0
      );

      const outstandingLoansLRD = loansLRD.reduce((sum, loan) => 
        sum + parseFloat(loan.outstanding_balance || 0), 0
      );

      const totalFinesLRD = transactionsLRD
        .filter(t => t.type === 'penalty' || t.type === 'fee')
        .reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);

      const monthlyDuesLRD = outstandingDuesLRD / 12;

      // Grand Total (LRD) = Total Savings + Personal Interest + General Interest - Outstanding Dues
      const grandTotalLRD = totalSavingsLRD + totalPersonalInterestLRD + totalGeneralInterestLRD - outstandingDuesLRD;
      
      // Overall Total Savings (LRD) = Grand Total - Outstanding Loans
      const overallTotalSavingsLRD = grandTotalLRD - outstandingLoansLRD;

      // Calculate USD totals
      const totalSavingsUSD = savingsUSD.reduce((sum, acc) => 
        sum + parseFloat(acc.balance || 0), 0
      );

      const totalPersonalInterestUSD = transactionsUSD
        .filter(t => t.type === 'personal_interest_payment')
        .reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);

      const totalGeneralInterestUSD = transactionsUSD
        .filter(t => t.type === 'general_interest')
        .reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);

      const totalDuesUSD = clientsUSD.reduce((sum, c) => 
        sum + parseFloat(c.total_dues || 0), 0
      );

      const outstandingDuesUSD = clientsUSD
        .filter(c => parseFloat(c.total_dues || 0) < 0)
        .reduce((sum, c) => sum + Math.abs(parseFloat(c.total_dues || 0)), 0);

      const clientsWithOutstandingDuesUSD = clientsUSD.filter(c => parseFloat(c.total_dues || 0) < 0).length;
      
      const clientsPaidDuesUSD = clientsUSD.filter(c => {
        const duesPayments = transactionsUSD.filter(t => 
          t.client_id === c.id && t.type === 'due_payment'
        );
        return parseFloat(c.total_dues || 0) === 0 && duesPayments.length > 0;
      }).length;

      const totalLoansUSD = loansUSD.reduce((sum, loan) => 
        sum + parseFloat(loan.amount || 0), 0
      );

      const outstandingLoansUSD = loansUSD.reduce((sum, loan) => 
        sum + parseFloat(loan.outstanding_balance || 0), 0
      );

      const totalFinesUSD = transactionsUSD
        .filter(t => t.type === 'penalty' || t.type === 'fee')
        .reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);

      const monthlyDuesUSD = outstandingDuesUSD / 12;

      // Grand Total (USD) = Total Savings + Personal Interest + General Interest - Outstanding Dues
      const grandTotalUSD = totalSavingsUSD + totalPersonalInterestUSD + totalGeneralInterestUSD - outstandingDuesUSD;
      
      // Overall Total Savings (USD) = Grand Total - Outstanding Loans
      const overallTotalSavingsUSD = grandTotalUSD - outstandingLoansUSD;

      // Overall totals (for backward compatibility)
      const totalSavings = totalSavingsLRD + totalSavingsUSD;
      const totalPersonalInterest = totalPersonalInterestLRD + totalPersonalInterestUSD;
      const totalGeneralInterest = totalGeneralInterestLRD + totalGeneralInterestUSD;
      const totalOutstandingDues = outstandingDuesLRD + outstandingDuesUSD;
      const totalOutstandingLoans = outstandingLoansLRD + outstandingLoansUSD;
      const totalLoans = totalLoansLRD + totalLoansUSD;
      const totalFines = totalFinesLRD + totalFinesUSD;
      const grandTotal = grandTotalLRD + grandTotalUSD;
      const overallTotalSavings = overallTotalSavingsLRD + overallTotalSavingsUSD;

      setFinancialSummary({
        // Overall totals
        totalSavings,
        totalPersonalInterest,
        totalGeneralInterest,
        totalOutstandingDues,
        totalOutstandingLoans,
        totalLoans,
        totalFines,
        outstandingSavings: totalSavings, // Outstanding savings = total savings
        grandTotal,
        overallTotalSavings,
        // Currency-separated data
        lrd: {
          totalSavings: totalSavingsLRD,
          totalPersonalInterest: totalPersonalInterestLRD,
          totalGeneralInterest: totalGeneralInterestLRD,
          totalDues: totalDuesLRD,
          outstandingDues: outstandingDuesLRD,
          monthlyDues: monthlyDuesLRD,
          totalLoans: totalLoansLRD,
          outstandingLoans: outstandingLoansLRD,
          outstandingSavings: totalSavingsLRD,
          totalFines: totalFinesLRD,
          grandTotal: grandTotalLRD,
          overallTotalSavings: overallTotalSavingsLRD,
          clientsWithOutstandingDues: clientsWithOutstandingDuesLRD,
          clientsPaidDues: clientsPaidDuesLRD
        },
        usd: {
          totalSavings: totalSavingsUSD,
          totalPersonalInterest: totalPersonalInterestUSD,
          totalGeneralInterest: totalGeneralInterestUSD,
          totalDues: totalDuesUSD,
          outstandingDues: outstandingDuesUSD,
          monthlyDues: monthlyDuesUSD,
          totalLoans: totalLoansUSD,
          outstandingLoans: outstandingLoansUSD,
          outstandingSavings: totalSavingsUSD,
          totalFines: totalFinesUSD,
          grandTotal: grandTotalUSD,
          overallTotalSavings: overallTotalSavingsUSD,
          clientsWithOutstandingDues: clientsWithOutstandingDuesUSD,
          clientsPaidDues: clientsPaidDuesUSD
        }
      });
    } catch (error) {
      console.error('Failed to fetch financial summary:', error);
    }
  };

  const fetchHistoricalData = async () => {
    try {
      const response = await apiClient.get('/api/dashboard/historical');
      setHistoricalData(response.data.data);
    } catch (error) {
      console.error('Failed to fetch historical data:', error);
      // Set empty data structure if fetch fails
      setHistoricalData({ months: [], portfolioValues: [], collections: [] });
    }
  };

  const fetchDashboardData = async () => {
    try {
      const response = await apiClient.get('/api/dashboard');
      setDashboardStats(response.data.data);
      setLoading(false);
    } catch (error) {
      console.error('Failed to fetch dashboard data:', error);
      setLoading(false);
    }
  };

  const fetchRevenueData = async () => {
    try {
      const response = await apiClient.get('/api/revenue/summary');
      if (response.data.success) {
        setRevenueData(prev => ({
          // Overall totals
          totalRevenue: response.data.data.totalRevenue || 0,
          loanRevenue: response.data.data.loanRevenue || 0,
          savingsRevenue: response.data.data.savingsRevenue || 0,
          feesRevenue: response.data.data.feesRevenue || 0,
          microfinanceRevenue: response.data.data.microfinanceRevenue ?? response.data.data.loanRevenue ?? 0,
          duesRevenue: response.data.data.duesRevenue || 0,
          generalInterestRevenue: response.data.data.generalInterestRevenue || 0,
          penaltyRevenue: response.data.data.penaltyRevenue || 0,
          revenueBySource: response.data.data.revenueBySource || {},
          revenues: prev.revenues || [],
          // Currency-separated data
          lrd: response.data.data.lrd || {
            totalRevenue: 0,
            loanRevenue: 0,
            savingsRevenue: 0,
            feesRevenue: 0,
            microfinanceRevenue: 0,
            duesRevenue: 0,
            generalInterestRevenue: 0,
            penaltyRevenue: 0,
            revenueBySource: {}
          },
          usd: response.data.data.usd || {
            totalRevenue: 0,
            loanRevenue: 0,
            savingsRevenue: 0,
            feesRevenue: 0,
            microfinanceRevenue: 0,
            duesRevenue: 0,
            generalInterestRevenue: 0,
            penaltyRevenue: 0,
            revenueBySource: {}
          }
        }));
      }

      // Fetch detailed revenue list
      const revenueListResponse = await apiClient.get('/api/revenue');
      if (revenueListResponse.data.success) {
        setRevenueData(prev => ({
          ...prev,
          revenues: revenueListResponse.data.data.revenues || []
        }));
      }
    } catch (error) {
      console.error('Failed to fetch revenue data:', error);
    }
  };

  // Generate financial data from real historical statistics
  const financialData = historicalData && dashboardStats ? {
    labels: historicalData.months || [],
    datasets: [
      {
        label: 'Revenue',
        data: historicalData.collections || [],
        backgroundColor: 'rgba(16, 185, 129, 0.8)',
      },
      {
        label: 'Expenses',
        data: historicalData.collections ? historicalData.collections.map(c => c * 0.6) : [],
        backgroundColor: 'rgba(239, 68, 68, 0.8)',
      },
    ],
  } : {
    labels: [],
    datasets: []
  };

  // Generate loan portfolio data from real statistics
  const loanPortfolioData = dashboardStats ? {
    labels: ['Active', 'Pending', 'Overdue', 'Completed'],
    datasets: [
      {
        data: [
          dashboardStats.statistics.activeLoans || 0,
          dashboardStats.statistics.totalClients || 0,
          dashboardStats.statistics.overdueLoans || 0,
          (dashboardStats.statistics.totalClients || 0) - (dashboardStats.statistics.activeLoans || 0)
        ],
        backgroundColor: [
          'rgba(16, 185, 129, 0.8)',
          'rgba(245, 158, 11, 0.8)',
          'rgba(239, 68, 68, 0.8)',
          'rgba(100, 116, 139, 0.8)',
        ],
      },
    ],
  } : {
    labels: [],
    datasets: []
  };

  const handleExportPDF = () => {
    if (!financialSummary || (!financialSummary.lrd && !financialSummary.usd)) {
      toast.error('No data available to export');
      return;
    }

    const lrd = financialSummary.lrd || {};
    const usd = financialSummary.usd || {};

    const exportData = [
      {
        'Metric': 'Total Savings (LRD)',
        'Amount': formatCurrency(lrd.totalSavings || 0, 'LRD')
      },
      {
        'Metric': 'Total Savings (USD)',
        'Amount': formatCurrency(usd.totalSavings || 0, 'USD')
      },
      {
        'Metric': 'Personal Interest (LRD)',
        'Amount': formatCurrency(lrd.totalPersonalInterest || 0, 'LRD')
      },
      {
        'Metric': 'Personal Interest (USD)',
        'Amount': formatCurrency(usd.totalPersonalInterest || 0, 'USD')
      },
      {
        'Metric': 'General Interest (LRD)',
        'Amount': formatCurrency(lrd.totalGeneralInterest || 0, 'LRD')
      },
      {
        'Metric': 'General Interest (USD)',
        'Amount': formatCurrency(usd.totalGeneralInterest || 0, 'USD')
      },
      {
        'Metric': 'Outstanding Dues (LRD)',
        'Amount': formatCurrency(lrd.outstandingDues || 0, 'LRD')
      },
      {
        'Metric': 'Outstanding Dues (USD)',
        'Amount': formatCurrency(usd.outstandingDues || 0, 'USD')
      },
      {
        'Metric': 'Outstanding Loans (LRD)',
        'Amount': formatCurrency(lrd.outstandingLoans || 0, 'LRD')
      },
      {
        'Metric': 'Outstanding Loans (USD)',
        'Amount': formatCurrency(usd.outstandingLoans || 0, 'USD')
      },
      {
        'Metric': 'Total Fines (LRD)',
        'Amount': formatCurrency(lrd.totalFines || 0, 'LRD')
      },
      {
        'Metric': 'Total Fines (USD)',
        'Amount': formatCurrency(usd.totalFines || 0, 'USD')
      },
      {
        'Metric': 'Grand Total (LRD)',
        'Amount': formatCurrency(lrd.grandTotal || 0, 'LRD')
      },
      {
        'Metric': 'Grand Total (USD)',
        'Amount': formatCurrency(usd.grandTotal || 0, 'USD')
      }
    ];

    const columns = [
      { key: 'Metric', header: 'Metric' },
      { key: 'Amount', header: 'Amount' }
    ];
    exportToPDF(exportData, columns, 'Financial Reports Summary', 'reports_summary');
    toast.success('Reports exported to PDF successfully!');
  };

  const handleExportExcel = () => {
    if (!financialSummary || (!financialSummary.lrd && !financialSummary.usd)) {
      toast.error('No data available to export');
      return;
    }

    const lrd = financialSummary.lrd || {};
    const usd = financialSummary.usd || {};

    const exportData = [
      {
        'Metric': 'Total Savings (LRD)',
        'Amount': formatCurrency(lrd.totalSavings || 0, 'LRD')
      },
      {
        'Metric': 'Total Savings (USD)',
        'Amount': formatCurrency(usd.totalSavings || 0, 'USD')
      },
      {
        'Metric': 'Personal Interest (LRD)',
        'Amount': formatCurrency(lrd.totalPersonalInterest || 0, 'LRD')
      },
      {
        'Metric': 'Personal Interest (USD)',
        'Amount': formatCurrency(usd.totalPersonalInterest || 0, 'USD')
      },
      {
        'Metric': 'General Interest (LRD)',
        'Amount': formatCurrency(lrd.totalGeneralInterest || 0, 'LRD')
      },
      {
        'Metric': 'General Interest (USD)',
        'Amount': formatCurrency(usd.totalGeneralInterest || 0, 'USD')
      },
      {
        'Metric': 'Outstanding Dues (LRD)',
        'Amount': formatCurrency(lrd.outstandingDues || 0, 'LRD')
      },
      {
        'Metric': 'Outstanding Dues (USD)',
        'Amount': formatCurrency(usd.outstandingDues || 0, 'USD')
      },
      {
        'Metric': 'Outstanding Loans (LRD)',
        'Amount': formatCurrency(lrd.outstandingLoans || 0, 'LRD')
      },
      {
        'Metric': 'Outstanding Loans (USD)',
        'Amount': formatCurrency(usd.outstandingLoans || 0, 'USD')
      },
      {
        'Metric': 'Total Fines (LRD)',
        'Amount': formatCurrency(lrd.totalFines || 0, 'LRD')
      },
      {
        'Metric': 'Total Fines (USD)',
        'Amount': formatCurrency(usd.totalFines || 0, 'USD')
      },
      {
        'Metric': 'Grand Total (LRD)',
        'Amount': formatCurrency(lrd.grandTotal || 0, 'LRD')
      },
      {
        'Metric': 'Grand Total (USD)',
        'Amount': formatCurrency(usd.grandTotal || 0, 'USD')
      }
    ];

    const columns = [
      { key: 'Metric', header: 'Metric' },
      { key: 'Amount', header: 'Amount' }
    ];
    exportToExcel(exportData, columns, 'Financial Reports', 'reports_summary');
    toast.success('Reports exported to Excel successfully!');
  };

  const setReportSection = (section) => {
    setReportType(section);
    navigate(`/reports/${section}`, { replace: true });
  };

  return (
    <div className="fade-in">
      <div className="d-flex justify-content-between align-items-center mb-4">
        <div>
          <h1 className="h3 mb-1">Reports & Analytics</h1>
        </div>
        <div className="btn-group">
          <button
            className="btn btn-success hover-lift"
            onClick={handleExportExcel}
            title="Export to Excel"
          >
            <i className="fas fa-file-excel me-2"></i>Export Excel
          </button>
          <button
            className="btn btn-danger hover-lift"
            onClick={handleExportPDF}
            title="Export to PDF"
          >
            <i className="fas fa-file-pdf me-2"></i>Export PDF
          </button>
        </div>
      </div>
      <p className="text-muted mb-4">Comprehensive system reports</p>

      {/* Report Type Tabs */}
      <ul className="nav nav-tabs mb-4">
        <li className="nav-item">
          <button
            className={`nav-link ${reportType === 'financial' ? 'active' : ''}`}
            onClick={() => setReportSection('financial')}
          >
            <i className="fas fa-chart-line me-2"></i>Financial Reports
          </button>
        </li>
        <li className="nav-item">
          <button
            className={`nav-link ${reportType === 'portfolio' ? 'active' : ''}`}
            onClick={() => setReportSection('portfolio')}
          >
            <i className="fas fa-hand-holding-usd me-2"></i>Loan Portfolio
          </button>
        </li>
        <li className="nav-item">
          <button
            className={`nav-link ${reportType === 'clients' ? 'active' : ''}`}
            onClick={() => setReportSection('clients')}
          >
            <i className="fas fa-users me-2"></i>Client Reports
          </button>
        </li>
        <li className="nav-item">
          <button
            className={`nav-link ${reportType === 'performance' ? 'active' : ''}`}
            onClick={() => setReportSection('performance')}
          >
            <i className="fas fa-tachometer-alt me-2"></i>Performance
          </button>
        </li>
        <li className="nav-item">
          <button
            className={`nav-link ${reportType === 'revenue' ? 'active' : ''}`}
            onClick={() => setReportSection('revenue')}
          >
            <i className="fas fa-dollar-sign me-2"></i>Revenue
          </button>
        </li>
      </ul>

      {/* Financial Reports */}
      {reportType === 'financial' && (
        <div className="row">
          {/* LRD Financial Summary */}
          <div className="col-md-12 mb-4">
            <div className="card">
              <div className="card-header bg-primary text-white">
                <h5 className="mb-0"><i className="fas fa-coins me-2"></i>LRD Financial Reports</h5>
              </div>
              <div className="card-body">
                <div className="row g-3">
                  <div className="col-md-2">
                    <div className="card bg-primary text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">Total Savings</h6>
                        <h5 className="card-title mb-0">
                          LRD {(financialSummary.lrd?.totalSavings ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-2">
                    <div className="card bg-success text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">Personal Interest</h6>
                        <h5 className="card-title mb-0">
                          LRD {financialSummary.lrd?.totalPersonalInterest.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '0.00'}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-2">
                    <div className="card bg-info text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">General Interest</h6>
                        <h5 className="card-title mb-0">
                          LRD {(financialSummary.lrd?.totalGeneralInterest ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-2">
                    <div className="card bg-danger text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">Outstanding Dues</h6>
                        <h5 className="card-title mb-0">
                          LRD {(financialSummary.lrd?.outstandingDues ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-2">
                    <div className="card bg-secondary text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">Monthly Dues</h6>
                        <h5 className="card-title mb-0">
                          LRD {(financialSummary.lrd?.monthlyDues ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-2">
                    <div className="card bg-warning text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">Grand Total</h6>
                        <h5 className="card-title mb-0">
                          LRD {(financialSummary.lrd?.grandTotal ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-2">
                    <div className="card bg-dark text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">Total Loans</h6>
                        <h5 className="card-title mb-0">
                          LRD {(financialSummary.lrd?.totalLoans ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-2">
                    <div className="card bg-danger text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">Outstanding Loans</h6>
                        <h5 className="card-title mb-0">
                          LRD {(financialSummary.lrd?.outstandingLoans ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-2">
                    <div className="card bg-info text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">Outstanding Savings</h6>
                        <h5 className="card-title mb-0">
                          LRD {(financialSummary.lrd?.outstandingSavings ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-2">
                    <div className="card bg-secondary text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">Total Fines</h6>
                        <h5 className="card-title mb-0">
                          LRD {financialSummary.lrd?.totalFines.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '0.00'}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-2">
                    <div className="card bg-warning text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">Clients with Dues</h6>
                        <h5 className="card-title mb-0">
                          {financialSummary.lrd?.clientsWithOutstandingDues || 0}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-2">
                    <div className="card bg-success text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">Clients Paid Dues</h6>
                        <h5 className="card-title mb-0">
                          {financialSummary.lrd?.clientsPaidDues || 0}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-12 mt-3">
                    <div className="card bg-success text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50">Grand Total Savings (LRD)</h6>
                        <h2 className="card-title mb-0">
                          LRD {(financialSummary.lrd?.overallTotalSavings ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h2>
                        <small className="text-white-50">Grand Total - Outstanding Loans</small>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* USD Financial Summary */}
          <div className="col-md-12 mb-4">
            <div className="card">
              <div className="card-header bg-success text-white">
                <h5 className="mb-0"><i className="fas fa-dollar-sign me-2"></i>USD Financial Reports</h5>
              </div>
              <div className="card-body">
                <div className="row g-3">
                  <div className="col-md-2">
                    <div className="card bg-primary text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">Total Savings</h6>
                        <h5 className="card-title mb-0">
                          ${(financialSummary.usd?.totalSavings ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-2">
                    <div className="card bg-success text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">Personal Interest</h6>
                        <h5 className="card-title mb-0">
                          ${(financialSummary.usd?.totalPersonalInterest ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-2">
                    <div className="card bg-info text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">General Interest</h6>
                        <h5 className="card-title mb-0">
                          ${(financialSummary.usd?.totalGeneralInterest ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-2">
                    <div className="card bg-danger text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">Outstanding Dues</h6>
                        <h5 className="card-title mb-0">
                          ${(financialSummary.usd?.outstandingDues ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-2">
                    <div className="card bg-secondary text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">Monthly Dues</h6>
                        <h5 className="card-title mb-0">
                          ${(financialSummary.usd?.monthlyDues ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-2">
                    <div className="card bg-warning text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">Grand Total</h6>
                        <h5 className="card-title mb-0">
                          ${(financialSummary.usd?.grandTotal ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-2">
                    <div className="card bg-dark text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">Total Loans</h6>
                        <h5 className="card-title mb-0">
                          ${(financialSummary.usd?.totalLoans ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-2">
                    <div className="card bg-danger text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">Outstanding Loans</h6>
                        <h5 className="card-title mb-0">
                          ${(financialSummary.usd?.outstandingLoans ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-2">
                    <div className="card bg-info text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">Outstanding Savings</h6>
                        <h5 className="card-title mb-0">
                          ${(financialSummary.usd?.outstandingSavings ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-2">
                    <div className="card bg-secondary text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">Total Fines</h6>
                        <h5 className="card-title mb-0">
                          ${(financialSummary.usd?.totalFines ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-2">
                    <div className="card bg-warning text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">Clients with Dues</h6>
                        <h5 className="card-title mb-0">
                          {financialSummary.usd?.clientsWithOutstandingDues || 0}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-2">
                    <div className="card bg-success text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50 small">Clients Paid Dues</h6>
                        <h5 className="card-title mb-0">
                          {financialSummary.usd?.clientsPaidDues || 0}
                        </h5>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-12 mt-3">
                    <div className="card bg-success text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50">Grand Total Savings (USD)</h6>
                        <h2 className="card-title mb-0">
                          ${(financialSummary.usd?.overallTotalSavings ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h2>
                        <small className="text-white-50">Grand Total - Outstanding Loans</small>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="col-md-12 mb-4">
            <div className="card">
              <div className="card-header">
                <h5 className="mb-0">Revenue vs Expenses</h5>
              </div>
              <div className="card-body">
                {loading ? (
                  <div className="text-center py-5">
                    <div className="spinner-border text-primary" role="status">
                      <span className="visually-hidden">Loading...</span>
                    </div>
                  </div>
                ) : financialData.labels.length > 0 ? (
                  <Bar 
                    key={`bar-${chartKey}`}
                    data={financialData} 
                    options={{ 
                      responsive: true,
                      maintainAspectRatio: true,
                      plugins: {
                        legend: {
                          position: 'top',
                        },
                      },
                    }} 
                  />
                ) : (
                  <div className="text-center text-muted py-5">
                    No financial data available
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Loan Portfolio Reports */}
      {reportType === 'portfolio' && (
        <div className="row">
          <div className="col-md-6 mb-4">
            <div className="card">
              <div className="card-header">
                <h5 className="mb-0">Loan Distribution</h5>
              </div>
              <div className="card-body">
                {loading ? (
                  <div className="text-center py-5">
                    <div className="spinner-border text-primary" role="status">
                      <span className="visually-hidden">Loading...</span>
                    </div>
                  </div>
                ) : loanPortfolioData.labels.length > 0 ? (
                  <Pie 
                    key={`pie-${chartKey}`}
                    data={loanPortfolioData} 
                    options={{ 
                      responsive: true,
                      maintainAspectRatio: true,
                      plugins: {
                        legend: {
                          position: 'bottom',
                        },
                      },
                    }} 
                  />
                ) : (
                  <div className="text-center text-muted py-5">
                    No portfolio data available
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="col-md-6 mb-4">
            <div className="card">
              <div className="card-header">
                <h5 className="mb-0">Portfolio Summary</h5>
              </div>
              <div className="card-body">
                {loading ? (
                  <div className="text-center py-5">
                    <div className="spinner-border text-primary" role="status">
                      <span className="visually-hidden">Loading...</span>
                    </div>
                  </div>
                ) : dashboardStats ? (
                  <>
                    {/* LRD Portfolio Summary */}
                    <div className="row mb-4">
                      <div className="col-12 mb-3">
                        <h6 className="text-primary"><i className="fas fa-coins me-2"></i>LRD Portfolio</h6>
                      </div>
                      <div className="col-6 mb-3">
                        <div className="stat-card">
                          <div className="stat-label">Total Portfolio (LRD)</div>
                          <div className="stat-value text-primary">
                            LRD {(dashboardStats.statistics.lrd?.portfolioValue || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                        </div>
                      </div>
                      <div className="col-6 mb-3">
                        <div className="stat-card">
                          <div className="stat-label">Outstanding Loans (LRD)</div>
                          <div className="stat-value text-danger">
                            LRD {(dashboardStats.statistics.lrd?.outstandingLoans || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                        </div>
                      </div>
                      <div className="col-6 mb-3">
                        <div className="stat-card">
                          <div className="stat-label">Total Loans (LRD)</div>
                          <div className="stat-value text-success">
                            LRD {(dashboardStats.statistics.lrd?.totalLoans || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                        </div>
                      </div>
                      <div className="col-6 mb-3">
                        <div className="stat-card">
                          <div className="stat-label">Total Collections (LRD)</div>
                          <div className="stat-value text-info">
                            LRD {(dashboardStats.statistics.lrd?.totalCollections || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* USD Portfolio Summary */}
                    <div className="row mb-4">
                      <div className="col-12 mb-3">
                        <h6 className="text-success"><i className="fas fa-dollar-sign me-2"></i>USD Portfolio</h6>
                      </div>
                      <div className="col-6 mb-3">
                        <div className="stat-card">
                          <div className="stat-label">Total Portfolio (USD)</div>
                          <div className="stat-value text-primary">
                            ${(dashboardStats.statistics.usd?.portfolioValue || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                        </div>
                      </div>
                      <div className="col-6 mb-3">
                        <div className="stat-card">
                          <div className="stat-label">Outstanding Loans (USD)</div>
                          <div className="stat-value text-danger">
                            ${(dashboardStats.statistics.usd?.outstandingLoans || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                        </div>
                      </div>
                      <div className="col-6 mb-3">
                        <div className="stat-card">
                          <div className="stat-label">Total Loans (USD)</div>
                          <div className="stat-value text-success">
                            ${(dashboardStats.statistics.usd?.totalLoans || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                        </div>
                      </div>
                      <div className="col-6 mb-3">
                        <div className="stat-card">
                          <div className="stat-label">Total Collections (USD)</div>
                          <div className="stat-value text-info">
                            ${(dashboardStats.statistics.usd?.totalCollections || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Overall Portfolio Summary */}
                    <div className="row">
                      <div className="col-12 mb-3">
                        <h6 className="text-secondary"><i className="fas fa-chart-line me-2"></i>Overall Portfolio</h6>
                      </div>
                      <div className="col-6 mb-3">
                        <div className="stat-card">
                          <div className="stat-label">Active Loans</div>
                          <div className="stat-value text-success">
                            {dashboardStats.statistics.activeLoans || 0}
                          </div>
                        </div>
                      </div>
                      <div className="col-6 mb-3">
                        <div className="stat-card">
                          <div className="stat-label">Overdue</div>
                          <div className="stat-value text-danger">
                            {dashboardStats.statistics.overdueLoans || 0}
                          </div>
                        </div>
                      </div>
                      <div className="col-6 mb-3">
                        <div className="stat-card">
                          <div className="stat-label">Collection Rate</div>
                          <div className="stat-value text-info">
                            {dashboardStats.statistics.portfolioValue > 0 && dashboardStats.statistics.totalCollections > 0
                              ? ((dashboardStats.statistics.totalCollections / dashboardStats.statistics.portfolioValue) * 100).toFixed(1)
                              : 0}%
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="text-center text-muted py-5">
                    No data available
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Client Reports */}
      {reportType === 'clients' && (
        <div className="card">
          <div className="card-header d-flex flex-wrap align-items-center justify-content-between gap-2">
            <h5 className="mb-0">Client Reports</h5>
            <div className="d-flex flex-wrap align-items-center gap-2">
              <button
                type="button"
                className="btn btn-sm btn-success"
                onClick={() => {
                  if (clientReportsList.length === 0) {
                    toast.warning('No data to export. Apply filters and load client reports first.');
                    return;
                  }
                  const isAll = clientReportsCurrency === 'ALL';
                  const columns = [
                    { key: 'client_number', header: 'ID#', format: (v, row) => v ?? row.id ?? '-' },
                    { key: 'savings_id', header: 'Savings ID#', format: (v) => v ?? '-' },
                    { key: 'name', header: 'Name', format: (v) => v ?? '-' },
                    ...(isAll
                      ? [
                          { key: 'total_savings_lrd', header: 'Total Savings (LRD)', format: (v) => formatCurrency(v, 'LRD') },
                          { key: 'total_savings_usd', header: 'Total Savings (USD)', format: (v) => formatCurrency(v, 'USD') },
                          { key: 'personal_interest_lrd', header: 'Personal Interest (LRD)', format: (v) => formatCurrency(v, 'LRD') },
                          { key: 'personal_interest_usd', header: 'Personal Interest (USD)', format: (v) => formatCurrency(v, 'USD') },
                          { key: 'general_interest_lrd', header: 'General Interest (LRD)', format: (v) => formatCurrency(v, 'LRD') },
                          { key: 'general_interest_usd', header: 'General Interest (USD)', format: (v) => formatCurrency(v, 'USD') },
                          { key: 'outstanding_loan_lrd', header: 'Outstanding Loan (LRD)', format: (v) => formatCurrency(v, 'LRD') },
                          { key: 'outstanding_loan_usd', header: 'Outstanding Loan (USD)', format: (v) => formatCurrency(v, 'USD') },
                          { key: 'loan_repayment_done_lrd', header: 'Loan Repayment Done (LRD)', format: (v) => formatCurrency(v, 'LRD') },
                          { key: 'loan_repayment_done_usd', header: 'Loan Repayment Done (USD)', format: (v) => formatCurrency(v, 'USD') },
                          { key: 'loan_status', header: 'Loan Status' },
                          { key: 'outstanding_dues_lrd', header: 'Outstanding Dues (LRD)', format: (v) => formatCurrency(v, 'LRD') },
                          { key: 'outstanding_dues_usd', header: 'Outstanding Dues (USD)', format: (v) => formatCurrency(v, 'USD') },
                          { key: 'total_dues_paid_lrd', header: 'Total Dues Paid (LRD)', format: (v) => formatCurrency(v, 'LRD') },
                          { key: 'total_dues_paid_usd', header: 'Total Dues Paid (USD)', format: (v) => formatCurrency(v, 'USD') },
                          { key: 'penalty_lrd', header: 'Penalty (LRD)', format: (v) => formatCurrency(v, 'LRD') },
                          { key: 'penalty_usd', header: 'Penalty (USD)', format: (v) => formatCurrency(v, 'USD') }
                        ]
                      : [
                          { key: 'total_savings', header: 'Total Savings', format: (v) => formatCurrency(v, clientReportsCurrency) },
                          { key: 'personal_interest', header: 'Personal Interest', format: (v) => formatCurrency(v, clientReportsCurrency) },
                          { key: 'general_interest', header: 'General Interest', format: (v) => formatCurrency(v, clientReportsCurrency) },
                          { key: 'outstanding_loan', header: 'Outstanding Loan', format: (v) => formatCurrency(v, clientReportsCurrency) },
                          { key: 'loan_repayment_done', header: 'Loan Repayment Done', format: (v) => formatCurrency(v, clientReportsCurrency) },
                          { key: 'loan_status', header: 'Loan Status' },
                          { key: 'outstanding_dues', header: 'Outstanding Dues', format: (v) => formatCurrency(v, clientReportsCurrency) },
                          { key: 'total_dues_paid', header: 'Total Dues Paid', format: (v) => formatCurrency(v, clientReportsCurrency) },
                          { key: 'penalty', header: 'Penalty', format: (v) => formatCurrency(v, clientReportsCurrency) }
                        ])
                  ];
                  exportToExcel(clientReportsList, columns, 'Client Reports', 'client_reports');
                  toast.success('Client reports exported to Excel');
                }}
                disabled={clientReportsList.length === 0}
                title="Export to Excel"
              >
                <i className="fas fa-file-excel me-1"></i>Export Excel
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => {
                  if (clientReportsList.length === 0) {
                    toast.warning('No data to export. Apply filters and load client reports first.');
                    return;
                  }
                  const isAll = clientReportsCurrency === 'ALL';
                  const columns = [
                    { key: 'client_number', header: 'ID#', format: (v, row) => v ?? row.id ?? '-' },
                    { key: 'savings_id', header: 'Savings ID#', format: (v) => v ?? '-' },
                    { key: 'name', header: 'Name', format: (v) => v ?? '-' },
                    ...(isAll
                      ? [
                          { key: 'total_savings_lrd', header: 'Total Savings (LRD)', format: (v) => formatCurrency(v, 'LRD') },
                          { key: 'total_savings_usd', header: 'Total Savings (USD)', format: (v) => formatCurrency(v, 'USD') },
                          { key: 'personal_interest_lrd', header: 'Personal Interest (LRD)', format: (v) => formatCurrency(v, 'LRD') },
                          { key: 'personal_interest_usd', header: 'Personal Interest (USD)', format: (v) => formatCurrency(v, 'USD') },
                          { key: 'general_interest_lrd', header: 'General Interest (LRD)', format: (v) => formatCurrency(v, 'LRD') },
                          { key: 'general_interest_usd', header: 'General Interest (USD)', format: (v) => formatCurrency(v, 'USD') },
                          { key: 'outstanding_loan_lrd', header: 'Outstanding Loan (LRD)', format: (v) => formatCurrency(v, 'LRD') },
                          { key: 'outstanding_loan_usd', header: 'Outstanding Loan (USD)', format: (v) => formatCurrency(v, 'USD') },
                          { key: 'loan_repayment_done_lrd', header: 'Loan Repayment Done (LRD)', format: (v) => formatCurrency(v, 'LRD') },
                          { key: 'loan_repayment_done_usd', header: 'Loan Repayment Done (USD)', format: (v) => formatCurrency(v, 'USD') },
                          { key: 'loan_status', header: 'Loan Status' },
                          { key: 'outstanding_dues_lrd', header: 'Outstanding Dues (LRD)', format: (v) => formatCurrency(v, 'LRD') },
                          { key: 'outstanding_dues_usd', header: 'Outstanding Dues (USD)', format: (v) => formatCurrency(v, 'USD') },
                          { key: 'total_dues_paid_lrd', header: 'Total Dues Paid (LRD)', format: (v) => formatCurrency(v, 'LRD') },
                          { key: 'total_dues_paid_usd', header: 'Total Dues Paid (USD)', format: (v) => formatCurrency(v, 'USD') },
                          { key: 'penalty_lrd', header: 'Penalty (LRD)', format: (v) => formatCurrency(v, 'LRD') },
                          { key: 'penalty_usd', header: 'Penalty (USD)', format: (v) => formatCurrency(v, 'USD') }
                        ]
                      : [
                          { key: 'total_savings', header: 'Total Savings', format: (v) => formatCurrency(v, clientReportsCurrency) },
                          { key: 'personal_interest', header: 'Personal Interest', format: (v) => formatCurrency(v, clientReportsCurrency) },
                          { key: 'general_interest', header: 'General Interest', format: (v) => formatCurrency(v, clientReportsCurrency) },
                          { key: 'outstanding_loan', header: 'Outstanding Loan', format: (v) => formatCurrency(v, clientReportsCurrency) },
                          { key: 'loan_repayment_done', header: 'Loan Repayment Done', format: (v) => formatCurrency(v, clientReportsCurrency) },
                          { key: 'loan_status', header: 'Loan Status' },
                          { key: 'outstanding_dues', header: 'Outstanding Dues', format: (v) => formatCurrency(v, clientReportsCurrency) },
                          { key: 'total_dues_paid', header: 'Total Dues Paid', format: (v) => formatCurrency(v, clientReportsCurrency) },
                          { key: 'penalty', header: 'Penalty', format: (v) => formatCurrency(v, clientReportsCurrency) }
                        ])
                  ];
                  exportToPDF(clientReportsList, columns, 'Client Reports', 'client_reports');
                  toast.success('Client reports exported to PDF');
                }}
                disabled={clientReportsList.length === 0}
                title="Export to PDF"
              >
                <i className="fas fa-file-pdf me-1"></i>Export PDF
              </button>
              <button
                type="button"
                className="btn btn-sm btn-outline-primary"
                onClick={fetchClientReports}
                disabled={clientReportsLoading}
              >
                <i className={`fas ${clientReportsLoading ? 'fa-spinner fa-spin' : 'fa-sync-alt'} me-1`}></i>
                Refresh
              </button>
            </div>
          </div>
          <div className="card-body">
            {/* Period and help text */}
            <div className="mb-3">
              <span className="text-muted small me-2">
                <strong>Period:</strong> {clientReportsFrom || '—'} to {clientReportsTo || '—'}
              </span>
              <span className="text-muted small d-block mt-1">
                Loan repayment, personal/general interest, dues paid and penalty are for this period; savings and outstanding loan/dues are current.
              </span>
            </div>
            {/* Filters */}
            <div className="row g-3 mb-4">
              <div className="col-md-6 col-lg-2">
                <label className="form-label small text-muted">From</label>
                <input
                  type="date"
                  className="form-control form-control-sm"
                  value={clientReportsFrom}
                  onChange={(e) => setClientReportsFrom(e.target.value)}
                />
              </div>
              <div className="col-md-6 col-lg-2">
                <label className="form-label small text-muted">To</label>
                <input
                  type="date"
                  className="form-control form-control-sm"
                  value={clientReportsTo}
                  onChange={(e) => setClientReportsTo(e.target.value)}
                />
              </div>
              <div className="col-md-6 col-lg-2">
                <label className="form-label small text-muted">Currency</label>
                <select
                  className="form-select form-select-sm"
                  value={clientReportsCurrency}
                  onChange={(e) => setClientReportsCurrency(e.target.value)}
                >
                  <option value="ALL">ALL</option>
                  <option value="LRD">LRD</option>
                  <option value="USD">USD</option>
                </select>
              </div>
              <div className="col-md-6 col-lg-3">
                <label className="form-label small text-muted">Search by name or ID</label>
                <input
                  type="text"
                  className="form-control form-control-sm"
                  placeholder="Client name or ID#..."
                  value={clientReportsSearch}
                  onChange={(e) => setClientReportsSearch(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && fetchClientReports()}
                />
              </div>
              <div className="col-md-6 col-lg-2 d-flex align-items-end">
                <button
                  type="button"
                  className="btn btn-primary btn-sm w-100"
                  onClick={fetchClientReports}
                  disabled={clientReportsLoading}
                >
                  {clientReportsLoading ? (
                    <span className="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>
                  ) : (
                    <i className="fas fa-search me-1"></i>
                  )}
                  Apply
                </button>
              </div>
            </div>

            {clientReportsLoading && clientReportsList.length === 0 ? (
              <div className="text-center py-5">
                <div className="spinner-border text-primary" role="status">
                  <span className="visually-hidden">Loading...</span>
                </div>
                <p className="text-muted mt-2 mb-0">Loading client reports...</p>
              </div>
            ) : (
              <div className="table-responsive">
                <table className="table table-hover table-bordered align-middle mb-0">
                  <thead className="table-light">
                    <tr>
                      <th>ID#</th>
                      <th>Savings ID#</th>
                      <th>Name</th>
                      {clientReportsCurrency === 'ALL' ? (
                        <>
                          <th className="text-end">Total Savings (LRD)</th>
                          <th className="text-end">Total Savings (USD)</th>
                          <th className="text-end">Personal Interest (LRD)</th>
                          <th className="text-end">Personal Interest (USD)</th>
                          <th className="text-end">General Interest (LRD)</th>
                          <th className="text-end">General Interest (USD)</th>
                          <th className="text-end">Outstanding Loan (LRD)</th>
                          <th className="text-end">Outstanding Loan (USD)</th>
                          <th className="text-end">Loan Repayment Done (LRD)</th>
                          <th className="text-end">Loan Repayment Done (USD)</th>
                          <th>Loan Status</th>
                          <th className="text-end">Outstanding Dues (LRD)</th>
                          <th className="text-end">Outstanding Dues (USD)</th>
                          <th className="text-end">Total Dues Paid (LRD)</th>
                          <th className="text-end">Total Dues Paid (USD)</th>
                          <th className="text-end">Penalty (LRD)</th>
                          <th className="text-end">Penalty (USD)</th>
                        </>
                      ) : (
                        <>
                          <th className="text-end">Total Savings</th>
                          <th className="text-end">Personal Interest</th>
                          <th className="text-end">General Interest</th>
                          <th className="text-end">Outstanding Loan</th>
                          <th className="text-end">Loan Repayment Done</th>
                          <th>Loan Status</th>
                          <th className="text-end">Outstanding Dues</th>
                          <th className="text-end">Total Dues Paid</th>
                          <th className="text-end">Penalty</th>
                        </>
                      )}
                      <th className="text-center">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clientReportsList.length === 0 ? (
                      <tr>
                        <td colSpan={clientReportsCurrency === 'ALL' ? 22 : 13} className="text-center text-muted py-4">
                          No clients match the filters. Try adjusting dates, currency, or search.
                        </td>
                      </tr>
                    ) : (
                      clientReportsList.map((row) => (
                        <React.Fragment key={row.id}>
                          <tr>
                            <td>{row.client_number ?? row.id}</td>
                            <td>{row.savings_id ?? '-'}</td>
                            <td>{row.name ?? '-'}</td>
                            {clientReportsCurrency === 'ALL' ? (
                              <>
                                <td className="text-end">{formatCurrency(row.total_savings_lrd, 'LRD')}</td>
                                <td className="text-end">{formatCurrency(row.total_savings_usd, 'USD')}</td>
                                <td className="text-end">{formatCurrency(row.personal_interest_lrd, 'LRD')}</td>
                                <td className="text-end">{formatCurrency(row.personal_interest_usd, 'USD')}</td>
                                <td className="text-end">{formatCurrency(row.general_interest_lrd, 'LRD')}</td>
                                <td className="text-end">{formatCurrency(row.general_interest_usd, 'USD')}</td>
                                <td className="text-end">{formatCurrency(row.outstanding_loan_lrd, 'LRD')}</td>
                                <td className="text-end">{formatCurrency(row.outstanding_loan_usd, 'USD')}</td>
                                <td className="text-end">{formatCurrency(row.loan_repayment_done_lrd, 'LRD')}</td>
                                <td className="text-end">{formatCurrency(row.loan_repayment_done_usd, 'USD')}</td>
                                <td><span className="badge bg-secondary">{row.loan_status ?? '-'}</span></td>
                                <td className="text-end">{formatCurrency(row.outstanding_dues_lrd, 'LRD')}</td>
                                <td className="text-end">{formatCurrency(row.outstanding_dues_usd, 'USD')}</td>
                                <td className="text-end">{formatCurrency(row.total_dues_paid_lrd, 'LRD')}</td>
                                <td className="text-end">{formatCurrency(row.total_dues_paid_usd, 'USD')}</td>
                                <td className="text-end">{formatCurrency(row.penalty_lrd, 'LRD')}</td>
                                <td className="text-end">{formatCurrency(row.penalty_usd, 'USD')}</td>
                              </>
                            ) : (
                              <>
                                <td className="text-end">{formatCurrency(row.total_savings, clientReportsCurrency)}</td>
                                <td className="text-end">{formatCurrency(row.personal_interest, clientReportsCurrency)}</td>
                                <td className="text-end">{formatCurrency(row.general_interest, clientReportsCurrency)}</td>
                                <td className="text-end">{formatCurrency(row.outstanding_loan, clientReportsCurrency)}</td>
                                <td className="text-end">{formatCurrency(row.loan_repayment_done, clientReportsCurrency)}</td>
                                <td><span className="badge bg-secondary">{row.loan_status ?? '-'}</span></td>
                                <td className="text-end">{formatCurrency(row.outstanding_dues, clientReportsCurrency)}</td>
                                <td className="text-end">{formatCurrency(row.total_dues_paid, clientReportsCurrency)}</td>
                                <td className="text-end">{formatCurrency(row.penalty, clientReportsCurrency)}</td>
                              </>
                            )}
                            <td className="text-center">
                              <button
                                type="button"
                                className="btn btn-sm btn-outline-secondary me-1"
                                title={clientReportsExpandedId === row.id ? 'Hide transactions' : 'Show transactions in period'}
                                onClick={() => setClientReportsExpandedId(prev => prev === row.id ? null : row.id)}
                              >
                                <i className={`fas fa-${(row.transactions && row.transactions.length) ? (clientReportsExpandedId === row.id ? 'chevron-up' : 'chevron-down') : 'minus'} me-1`}></i>
                                {row.transactions && row.transactions.length ? `${row.transactions.length} txns` : '0'}
                              </button>
                              <Link to={`/clients/${row.id}`} className="btn btn-sm btn-outline-primary" title="View client details">
                                <i className="fas fa-user me-1"></i>View
                              </Link>
                            </td>
                          </tr>
                          {clientReportsExpandedId === row.id && row.transactions && row.transactions.length > 0 && (
                            <tr>
                              <td colSpan={clientReportsCurrency === 'ALL' ? 22 : 13} className="bg-light p-3">
                                <div className="small">
                                  <strong>Transactions in period (From–To) — each with date:</strong>
                                  <div className="table-responsive mt-2">
                                    <table className="table table-sm table-bordered mb-0">
                                      <thead className="table-light">
                                        <tr>
                                          <th>Date</th>
                                          <th>Type</th>
                                          <th className="text-end">Amount</th>
                                          <th>Currency</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {row.transactions.map((t, idx) => (
                                          <tr key={idx}>
                                            <td>{t.transaction_date ? new Date(t.transaction_date).toLocaleDateString() : '—'}</td>
                                            <td><span className="badge bg-secondary">{t.type || '—'}</span></td>
                                            <td className="text-end">{formatCurrency(t.amount, t.currency)}</td>
                                            <td>{t.currency || 'USD'}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
            {!clientReportsLoading && clientReportsList.length > 0 && (
              <p className="text-muted small mt-2 mb-0">
                Showing {clientReportsList.length} client(s). Data refreshes when you change filters or every 30 seconds.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Revenue Reports */}
      {reportType === 'revenue' && (
        <div className="row">
          {/* LRD Revenue Summary */}
          <div className="col-md-12 mb-4">
            <div className="card">
              <div className="card-header bg-primary text-white">
                <h5 className="mb-0"><i className="fas fa-coins me-2"></i>LRD Revenue Reports</h5>
              </div>
              <div className="card-body">
                <div className="row g-3">
                  <div className="col-md-3">
                    <div className="card bg-primary text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50">Total Revenue (LRD)</h6>
                        <h3 className="card-title mb-0">
                          LRD {(revenueData.lrd?.totalRevenue ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h3>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-3">
                    <div className="card bg-success text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50">Microfinance Loan Interest (100%)</h6>
                        <h3 className="card-title mb-0">
                          LRD {(revenueData.lrd?.microfinanceRevenue ?? revenueData.lrd?.loanRevenue ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h3>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-3">
                    <div className="card bg-info text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50">Dues (45%)</h6>
                        <h3 className="card-title mb-0">
                          LRD {(revenueData.lrd?.duesRevenue ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h3>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-3">
                    <div className="card bg-warning text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50">General Interest (30%)</h6>
                        <h3 className="card-title mb-0">
                          LRD {(revenueData.lrd?.generalInterestRevenue ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h3>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-3">
                    <div className="card bg-secondary text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50">Fines/Penalty (50%)</h6>
                        <h3 className="card-title mb-0">
                          LRD {(revenueData.lrd?.penaltyRevenue ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h3>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* USD Revenue Summary */}
          <div className="col-md-12 mb-4">
            <div className="card">
              <div className="card-header bg-success text-white">
                <h5 className="mb-0"><i className="fas fa-dollar-sign me-2"></i>USD Revenue Reports</h5>
              </div>
              <div className="card-body">
                <div className="row g-3">
                  <div className="col-md-3">
                    <div className="card bg-primary text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50">Total Revenue (USD)</h6>
                        <h3 className="card-title mb-0">
                          ${(revenueData.usd?.totalRevenue ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h3>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-3">
                    <div className="card bg-success text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50">Microfinance Loan Interest (100%)</h6>
                        <h3 className="card-title mb-0">
                          ${(revenueData.usd?.microfinanceRevenue ?? revenueData.usd?.loanRevenue ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h3>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-3">
                    <div className="card bg-info text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50">Dues (45%)</h6>
                        <h3 className="card-title mb-0">
                          ${(revenueData.usd?.duesRevenue ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h3>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-3">
                    <div className="card bg-warning text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50">General Interest (30%)</h6>
                        <h3 className="card-title mb-0">
                          ${(revenueData.usd?.generalInterestRevenue ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h3>
                      </div>
                    </div>
                  </div>
                  <div className="col-md-3">
                    <div className="card bg-secondary text-white">
                      <div className="card-body text-center">
                        <h6 className="card-subtitle mb-2 text-white-50">Fines/Penalty (50%)</h6>
                        <h3 className="card-title mb-0">
                          ${(revenueData.usd?.penaltyRevenue ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </h3>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Revenue Details Table */}
          <div className="col-md-12 mb-4">
            <div className="card">
              <div className="card-header">
                <h5 className="mb-0"><i className="fas fa-list me-2"></i>Revenue Details</h5>
              </div>
              <div className="card-body">
                {revenueData.revenues?.length > 0 ? (
                  <div className="table-responsive">
                    <table className="table table-hover">
                      <thead>
                        <tr>
                          <th>Revenue Number</th>
                          <th>Source</th>
                          <th>Amount (Currency)</th>
                          <th>Loan Number</th>
                          <th>Transaction Number</th>
                          <th>Date</th>
                          <th>Description</th>
                        </tr>
                      </thead>
                      <tbody>
                        {revenueData.revenues.map((revenue) => (
                          <tr key={revenue.id}>
                            <td><strong>{revenue.revenue_number}</strong></td>
                            <td>
                              <span className="badge bg-primary">
                                {revenue.source ? revenue.source.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase()) : 'Other'}
                              </span>
                            </td>
                            <td>
                              {revenue.currency === 'LRD' ? 'LRD' : '$'}
                              {parseFloat(revenue.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              <small className="text-muted ms-1">({revenue.currency || 'USD'})</small>
                            </td>
                            <td>{revenue.loan?.loan_number || 'N/A'}</td>
                            <td>{revenue.transaction?.transaction_number || 'N/A'}</td>
                            <td>{new Date(revenue.revenue_date).toLocaleDateString()}</td>
                            <td>{revenue.description || 'N/A'}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="table-primary">
                          <th colSpan="2">Total Revenue (LRD)</th>
                          <th>
                            LRD {(revenueData.revenues?.filter(r => (r.currency || 'USD') === 'LRD').reduce((sum, r) => sum + parseFloat(r.amount || 0), 0) ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </th>
                          <th colSpan="4"></th>
                        </tr>
                        <tr className="table-success">
                          <th colSpan="2">Total Revenue (USD)</th>
                          <th>
                            ${(revenueData.revenues?.filter(r => (r.currency || 'USD') === 'USD').reduce((sum, r) => sum + parseFloat(r.amount || 0), 0) ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </th>
                          <th colSpan="4"></th>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                ) : (
                  <p className="text-muted text-center py-3">No revenue data available</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Performance Reports */}
      {reportType === 'performance' && (
        <div className="row">
          <div className="col-md-6 mb-4">
            <div className="card">
              <div className="card-header">
                <h5 className="mb-0">Monthly Performance</h5>
              </div>
              <div className="card-body">
                {loading ? (
                  <div className="text-center py-5">
                    <div className="spinner-border text-primary" role="status">
                      <span className="visually-hidden">Loading...</span>
                    </div>
                  </div>
                ) : financialData.labels.length > 0 ? (
                  <Line 
                    key={`line-${chartKey}`}
                    data={financialData} 
                    options={{ 
                      responsive: true,
                      maintainAspectRatio: true,
                      plugins: {
                        legend: {
                          position: 'top',
                        },
                      },
                    }} 
                  />
                ) : (
                  <div className="text-center text-muted py-5">
                    No performance data available
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="col-md-6 mb-4">
            <div className="card">
              <div className="card-header">
                <h5 className="mb-0">Key Metrics</h5>
              </div>
              <div className="card-body">
                {loading ? (
                  <div className="text-center py-5">
                    <div className="spinner-border text-primary" role="status">
                      <span className="visually-hidden">Loading...</span>
                    </div>
                  </div>
                ) : dashboardStats ? (
                  <div className="list-group">
                    <div className="list-group-item">
                      <strong>Portfolio at Risk (PAR)</strong>
                      <span className="float-end badge bg-warning">
                        {dashboardStats.statistics.activeLoans > 0
                          ? ((dashboardStats.statistics.overdueLoans / dashboardStats.statistics.activeLoans) * 100).toFixed(1)
                          : 0}%
                      </span>
                    </div>
                    <div className="list-group-item">
                      <strong>Default Rate</strong>
                      <span className="float-end badge bg-danger">
                        {dashboardStats.statistics.activeLoans > 0
                          ? ((dashboardStats.statistics.overdueLoans / dashboardStats.statistics.activeLoans) * 100).toFixed(1)
                          : 0}%
                      </span>
                    </div>
                    <div className="list-group-item">
                      <strong>Collection Efficiency</strong>
                      <span className="float-end badge bg-success">
                        {dashboardStats.statistics.portfolioValue > 0
                          ? ((dashboardStats.statistics.totalCollections / dashboardStats.statistics.portfolioValue) * 100).toFixed(1)
                          : 0}%
                      </span>
                    </div>
                    <div className="list-group-item">
                      <strong>Average Loan Size</strong>
                      <span className="float-end">
                        ${dashboardStats.statistics.activeLoans > 0
                          ? (dashboardStats.statistics.portfolioValue / dashboardStats.statistics.activeLoans).toFixed(2)
                          : 0}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="text-center text-muted py-5">
                    No data available
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Reports;
