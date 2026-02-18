import React, { useState, useEffect } from 'react';
import apiClient from '../config/axios';
import { toast } from 'react-toastify';
import { useAuth } from '../contexts/AuthContext';
import { APPROVER_ROLES } from '../utils/permissions';
import { Link } from 'react-router-dom';

const ApprovalCenter = () => {
  const { user } = useAuth();
  const [pendingLoans, setPendingLoans] = useState([]);
  const [pendingTransactions, setPendingTransactions] = useState([]);
  const [pendingSavings, setPendingSavings] = useState([]);
  const [pendingKyc, setPendingKyc] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('loans');

  const canApprove = APPROVER_ROLES.includes(user?.role);
  const canApproveKyc = ['admin', 'micro_loan_officer', 'head_micro_loan', 'general_manager', 'branch_manager'].includes(user?.role);

  useEffect(() => {
    fetchAllPending();
  }, []);

  const fetchAllPending = async () => {
    setLoading(true);
    try {
      const [loansRes, transactionsRes, savingsRes, kycRes] = await Promise.all([
        apiClient.get('/api/loans', { params: { status: 'pending', limit: 100 } }),
        apiClient.get('/api/transactions', { params: { status: 'pending', type: 'deposit,withdrawal', limit: 100 } }),
        apiClient.get('/api/savings', { params: { status: 'pending' } }),
        apiClient.get('/api/kyc', { params: { status: 'pending' } }).catch(() => ({ data: { data: { documents: [] } } }))
      ]);
      setPendingLoans(loansRes.data?.data?.loans ?? []);
      setPendingTransactions(transactionsRes.data?.data?.transactions ?? []);
      setPendingSavings(savingsRes.data?.data?.savingsAccounts ?? []);
      setPendingKyc(kycRes.data?.data?.documents ?? []);
    } catch (error) {
      console.error('Failed to fetch pending items:', error);
      toast.error('Failed to load pending approvals');
    } finally {
      setLoading(false);
    }
  };

  const handleApproveLoan = async (id) => {
    try {
      await apiClient.post(`/api/loans/${id}/approve`);
      toast.success('Loan approved successfully!');
      fetchAllPending();
    } catch (error) {
      toast.error(error.response?.data?.message || 'Failed to approve loan');
    }
  };

  const handleRejectLoan = async (id) => {
    if (!window.confirm('Are you sure you want to reject this loan?')) return;
    try {
      await apiClient.post(`/api/loans/${id}/reject`);
      toast.success('Loan rejected');
      fetchAllPending();
    } catch (error) {
      toast.error(error.response?.data?.message || 'Failed to reject loan');
    }
  };

  const handleApproveTransaction = async (id) => {
    try {
      await apiClient.post(`/api/transactions/${id}/approve`);
      toast.success('Transaction approved successfully!');
      fetchAllPending();
    } catch (error) {
      toast.error(error.response?.data?.message || 'Failed to approve transaction');
    }
  };

  const handleApproveSavings = async (id) => {
    try {
      await apiClient.post(`/api/savings/${id}/approve`);
      toast.success('Savings account approved successfully!');
      fetchAllPending();
    } catch (error) {
      toast.error(error.response?.data?.message || 'Failed to approve savings account');
    }
  };

  const handleApproveKyc = async (id, status = 'verified') => {
    try {
      await apiClient.post(`/api/kyc/${id}/approve`, { status });
      toast.success(status === 'verified' ? 'KYC document approved!' : 'KYC document rejected');
      fetchAllPending();
    } catch (error) {
      toast.error(error.response?.data?.message || 'Failed to update KYC document');
    }
  };

  const totalPending = pendingLoans.length + pendingTransactions.length + pendingSavings.length + pendingKyc.length;

  return (
    <div className="fade-in">
      <div className="d-flex justify-content-between align-items-center mb-4">
        <div>
          <h1 className="h3 mb-1">Approval Center</h1>
          <p className="text-muted">Review and approve pending loans, transactions, savings accounts, and KYC documents</p>
        </div>
        <button className="btn btn-outline-primary" onClick={fetchAllPending} disabled={loading}>
          <i className="fas fa-sync-alt me-2"></i>Refresh
        </button>
      </div>

      {!canApprove && !canApproveKyc && (
        <div className="alert alert-warning">
          <i className="fas fa-exclamation-triangle me-2"></i>
          You do not have permission to approve items.
        </div>
      )}

      <div className="row mb-4">
        <div className="col-6 col-md-3">
          <div className="stat-card hover-lift" onClick={() => setActiveTab('loans')} style={{ cursor: 'pointer' }}>
            <div className="stat-icon bg-warning text-white">
              <i className="fas fa-hand-holding-usd"></i>
            </div>
            <div className="stat-label">Pending Loans</div>
            <div className="stat-value text-warning">{pendingLoans.length}</div>
          </div>
        </div>
        <div className="col-6 col-md-3">
          <div className="stat-card hover-lift" onClick={() => setActiveTab('transactions')} style={{ cursor: 'pointer' }}>
            <div className="stat-icon bg-info text-white">
              <i className="fas fa-exchange-alt"></i>
            </div>
            <div className="stat-label">Pending Transactions</div>
            <div className="stat-value text-info">{pendingTransactions.length}</div>
          </div>
        </div>
        <div className="col-6 col-md-3">
          <div className="stat-card hover-lift" onClick={() => setActiveTab('savings')} style={{ cursor: 'pointer' }}>
            <div className="stat-icon bg-success text-white">
              <i className="fas fa-piggy-bank"></i>
            </div>
            <div className="stat-label">Pending Savings</div>
            <div className="stat-value text-success">{pendingSavings.length}</div>
          </div>
        </div>
        <div className="col-6 col-md-3">
          <div className="stat-card hover-lift" onClick={() => setActiveTab('kyc')} style={{ cursor: 'pointer' }}>
            <div className="stat-icon bg-secondary text-white">
              <i className="fas fa-id-card"></i>
            </div>
            <div className="stat-label">Pending KYC</div>
            <div className="stat-value text-secondary">{pendingKyc.length}</div>
          </div>
        </div>
      </div>

      <ul className="nav nav-tabs mb-3">
        <li className="nav-item">
          <button className={`nav-link ${activeTab === 'loans' ? 'active' : ''}`} onClick={() => setActiveTab('loans')}>
            Loans ({pendingLoans.length})
          </button>
        </li>
        <li className="nav-item">
          <button className={`nav-link ${activeTab === 'transactions' ? 'active' : ''}`} onClick={() => setActiveTab('transactions')}>
            Transactions ({pendingTransactions.length})
          </button>
        </li>
        <li className="nav-item">
          <button className={`nav-link ${activeTab === 'savings' ? 'active' : ''}`} onClick={() => setActiveTab('savings')}>
            Savings ({pendingSavings.length})
          </button>
        </li>
        <li className="nav-item">
          <button className={`nav-link ${activeTab === 'kyc' ? 'active' : ''}`} onClick={() => setActiveTab('kyc')}>
            KYC Documents ({pendingKyc.length})
          </button>
        </li>
      </ul>

      <div className="card">
        <div className="card-body p-0">
          {loading ? (
            <div className="text-center py-5">
              <div className="spinner-border text-primary" role="status">
                <span className="visually-hidden">Loading...</span>
              </div>
            </div>
          ) : (
            <>
              {/* Pending Loans */}
              {activeTab === 'loans' && (
                <div className="table-responsive">
                  <table className="table table-hover mb-0">
                    <thead>
                      <tr>
                        <th>Type</th>
                        <th>Reference</th>
                        <th>Client</th>
                        <th>Amount</th>
                        <th>Submitted</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingLoans.length > 0 ? (
                        pendingLoans.map((item) => (
                          <tr key={item.id} className="hover-lift">
                            <td><span className="badge bg-info">Loan</span></td>
                            <td><Link to={`/loans/${item.id}`}>{item.loan_number}</Link></td>
                            <td>{item.client?.first_name} {item.client?.last_name}</td>
                            <td>{(item.currency === 'LRD' ? 'LRD' : '$')}{parseFloat(item.amount || 0).toLocaleString()}</td>
                            <td>{new Date(item.createdAt).toLocaleDateString()}</td>
                            <td>
                              {canApprove && (
                                <div className="btn-group">
                                  <button className="btn btn-sm btn-outline-success" onClick={() => handleApproveLoan(item.id)}>
                                    <i className="fas fa-check"></i> Approve
                                  </button>
                                  <button className="btn btn-sm btn-outline-danger" onClick={() => handleRejectLoan(item.id)}>
                                    <i className="fas fa-times"></i> Reject
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan="6" className="text-center text-muted py-5">No pending loans</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Pending Transactions */}
              {activeTab === 'transactions' && (
                <div className="table-responsive">
                  <table className="table table-hover mb-0">
                    <thead>
                      <tr>
                        <th>Type</th>
                        <th>Transaction #</th>
                        <th>Client</th>
                        <th>Amount</th>
                        <th>Date</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingTransactions.length > 0 ? (
                        pendingTransactions.map((item) => (
                          <tr key={item.id} className="hover-lift">
                            <td>
                              <span className={`badge bg-${item.type === 'deposit' ? 'success' : 'warning'}`}>
                                {item.type}
                              </span>
                            </td>
                            <td>{item.transaction_number}</td>
                            <td>{item.client?.first_name} {item.client?.last_name}</td>
                            <td>{(item.currency === 'LRD' ? 'LRD' : '$')}{parseFloat(item.amount || 0).toLocaleString()}</td>
                            <td>{new Date(item.transaction_date || item.createdAt).toLocaleDateString()}</td>
                            <td>
                              {canApprove && (
                                <button className="btn btn-sm btn-outline-success" onClick={() => handleApproveTransaction(item.id)}>
                                  <i className="fas fa-check"></i> Approve
                                </button>
                              )}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan="6" className="text-center text-muted py-5">No pending transactions</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Pending Savings */}
              {activeTab === 'savings' && (
                <div className="table-responsive">
                  <table className="table table-hover mb-0">
                    <thead>
                      <tr>
                        <th>Account #</th>
                        <th>Client</th>
                        <th>Type</th>
                        <th>Submitted</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingSavings.length > 0 ? (
                        pendingSavings.map((item) => (
                          <tr key={item.id} className="hover-lift">
                            <td><Link to={`/savings/${item.id}`}>{item.account_number}</Link></td>
                            <td>{item.client?.first_name} {item.client?.last_name}</td>
                            <td><span className="badge bg-secondary">{item.account_type || 'Regular'}</span></td>
                            <td>{new Date(item.createdAt).toLocaleDateString()}</td>
                            <td>
                              {canApprove && (
                                <button className="btn btn-sm btn-outline-success" onClick={() => handleApproveSavings(item.id)}>
                                  <i className="fas fa-check"></i> Approve
                                </button>
                              )}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan="5" className="text-center text-muted py-5">No pending savings accounts</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Pending KYC */}
              {activeTab === 'kyc' && (
                <div className="table-responsive">
                  <table className="table table-hover mb-0">
                    <thead>
                      <tr>
                        <th>Document Type</th>
                        <th>Client</th>
                        <th>Document #</th>
                        <th>Submitted</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingKyc.length > 0 ? (
                        pendingKyc.map((item) => (
                          <tr key={item.id} className="hover-lift">
                            <td><span className="badge bg-info">{item.document_type?.replace(/_/g, ' ')}</span></td>
                            <td>{item.client?.first_name} {item.client?.last_name}</td>
                            <td>{item.document_number || '-'}</td>
                            <td>{new Date(item.createdAt).toLocaleDateString()}</td>
                            <td>
                              {canApproveKyc && (
                                <div className="btn-group">
                                  <button className="btn btn-sm btn-outline-success" onClick={() => handleApproveKyc(item.id, 'verified')}>
                                    <i className="fas fa-check"></i> Approve
                                  </button>
                                  <button className="btn btn-sm btn-outline-danger" onClick={() => handleApproveKyc(item.id, 'rejected')}>
                                    <i className="fas fa-times"></i> Reject
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan="5" className="text-center text-muted py-5">No pending KYC documents</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default ApprovalCenter;
